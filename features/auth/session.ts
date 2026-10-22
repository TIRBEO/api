import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { signToken, verifyToken, COOKIE_NAME } from '@/features/auth/jwt';
import { DEVICE_COOKIE_NAME, ensureDeviceId, rememberDeviceAccount, wasRecentlyRemoved } from '@/features/auth/device-accounts';
import { TIRBEO_MAIL_DOMAIN, tirbeoEmailFor } from '@/features/identity/tirbeo';
import {
  hashRefreshToken,
  generateRefreshToken,
  markRefreshSpent,
  isRefreshSpent,
  saveSessionState,
  getSessionState,
  revokeSessionState,
  readCachedSessionIdentity,
  setCachedSessionIdentity,
  deleteCachedSessionIdentity } from '@/features/auth/redis';
import { createTtlCache } from '@/infrastructure/cache';
import { currentRequestOrigin } from '@/infrastructure/observability/requestContext';

// Short-TTL in-memory cache for session lookups. Authenticated requests hit
// this instead of the DB on every call (the DB lookup is the dominant cost,
// especially on cold connections). Busted on revoke. A few seconds of grace
// after revocation is acceptable for a large per-request latency win.
// 45s keeps the dashboard's 15s ticket poll + 30s notification poll inside
// the window so polls are served from memory, not the DB.
const sessionCache = createTtlCache<{ userId: string; email: string; sessionId: string; adminRole: string | null } | null>(45_000, 10_000, 'session');

// Hard deadlines for cache/DB lookups in the session path. Without them, a
// stalled Supabase/Redis connection hangs EVERY authenticated request for
// minutes (observed as "401 in 16.7min"). Fail closed — but in seconds.
const SESSION_CACHE_DEADLINE_MS = 1_500;
const SESSION_DB_DEADLINE_MS = 3_500;

/**
 * The session could not be LOOKED UP (pool exhausted, DB unreachable), which is
 * a different fact from "looked up, and it is dead".
 *
 * Collapsing the two into a 401 is what logs people out on a healthy account:
 * the dashboard treats a 401 as a dead credential and calls /api/auth/logout,
 * which revokes the session row — so one 3.5-second checkout timeout becomes a
 * durable sign-out that no retry can undo. Throw this instead and answer 503,
 * which every client already reads as "the server is having a moment".
 */
export class SessionUnavailableError extends Error {
  constructor(message = 'Session lookup unavailable') {
    super(message);
    this.name = 'SessionUnavailableError';
  }
}

/** Instance check that survives the class being loaded twice (route bundle +
 *  custom WS server), which `instanceof` does not. */
export function isSessionUnavailable(err: unknown): boolean {
  return err instanceof SessionUnavailableError ||
    (err as { name?: string } | null)?.name === 'SessionUnavailableError';
}

/** What `withDeadline` resolves to when the work has not answered in time.
 *  A sentinel instead of `null` because callers need to tell "no result" apart
 *  from "no answer" — see SessionUnavailableError. */
const DB_UNANSWERED = Symbol('db-unanswered');

function withDeadline<T, U = null>(p: Promise<T>, ms: number, onTimeout?: U): Promise<T | U> {
  return Promise.race([
    p,
    new Promise<U>((resolve) => setTimeout(() => resolve(onTimeout as U), ms)),
  ]);
}

export const COOKIE_DOMAIN = process.env.NEXT_PUBLIC_COOKIE_DOMAIN || '.tirbeo.com';

const ACCESS_COOKIE_MAX_AGE = 60 * 15;
const REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

// Idle window is 1h by product decision ("logout once user is offline for 1 hr"):
// accounts with saveLoginInfo OFF get a session whose expiresAt slides to
// last-activity + 1h, so no request path and no refresh can extend it past an
// hour of quiet.
export const SAVE_LOGIN_IDLE_MS = 60 * 60 * 1000;
/** How recently a token must have been spent for a replay to read as two tabs
    refreshing the same shared cookie rather than as theft. */
const REFRESH_RACE_GRACE_MS = 15_000;

export const REFRESH_COOKIE_NAME = '__refresh';

/** Activity ledger for session lifecycle. Dynamic import + fire-and-forget:
 *  the session path must never block on the security module, and tests that
 *  mock only prisma keep passing. */
function logSessionEvent(eventType: string, userId: string, details: Record<string, unknown>): void {
  import('@/features/security/security')
    .then(({ logSecurityEvent }) => logSecurityEvent({ userId, eventType, severity: 'info', details }))
    .catch(() => {});
}

const IS_PROD = process.env.NODE_ENV !== 'development';

// Google-style cookie posture, env-tunable so a deployment can widen sharing
// without code changes:
//   COOKIE_SAMESITE = 'lax' (default) | 'none'  — 'none' enables cross-SITE
//     (different top-level domain) sharing; browsers then REQUIRE Secure.
//   COOKIE_PARTITIONED = 'false' opts out of the storage-access partition that
//     SameSite=None needs to survive Chrome third-party-cookie phase-out.
// Secure is ALWAYS on in production (a missing/overridden domain must never
// silently downgrade the session cookie to plaintext-transport).
const COOKIE_SAMESITE = (process.env.COOKIE_SAMESITE === 'none' ? 'none' : 'lax') as 'lax' | 'none';
const COOKIE_SECURE = IS_PROD || COOKIE_SAMESITE === 'none';
const COOKIE_PARTITIONED = COOKIE_SAMESITE === 'none' && process.env.COOKIE_PARTITIONED !== 'false';

/**
 * Determine the correct cookie domain for the current request.
 * In production use COOKIE_DOMAIN (.tirbeo.com) so the session is shared
 * across all subdomains (accounts/dashboard/forms/cdn). On localhost the
 * cookie must be host-only (no Domain attribute) — browsers reject
 * Domain=localhost and host-only cookies are automatically sent to every
 * localhost:port (same host, different port) so all dev apps share one
 * session without extra config.
 */
function getCookieDomain(request?: NextRequest): string | undefined {
  const host = request?.headers?.get('host') || '';
  const isLocalhost = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  if (isLocalhost) return undefined;
  return COOKIE_DOMAIN;
}

function baseCookieOptions(request?: NextRequest) {
  const domain = getCookieDomain(request);
  return {
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAMESITE,
    ...(COOKIE_PARTITIONED ? { partitioned: true } : {}),
    path: '/' as const,
    ...(domain ? { domain } : {}) };
}

function getAccessCookieOptions(request?: NextRequest) {
  return { httpOnly: true, maxAge: ACCESS_COOKIE_MAX_AGE, ...baseCookieOptions(request) };
}

function getRefreshCookieOptions(request?: NextRequest, shortSession?: boolean) {
  // Short (idle-capped) sessions must not leave a 30-day refresh token in the
  // browser — the cookie dies with the policy window instead of lingering as a
  // token the server already refuses.
  return { httpOnly: true, maxAge: shortSession ? SAVE_LOGIN_IDLE_MS / 1000 : REFRESH_COOKIE_MAX_AGE, ...baseCookieOptions(request) };
}

const CSRF_COOKIE_NAME = '__csrf';
function getCsrfCookieOptions(request?: NextRequest) {
  // CSRF cookie is read by client JS for the double-submit token, so httpOnly
  // must stay false; it carries no authority on its own.
  return { httpOnly: false, maxAge: ACCESS_COOKIE_MAX_AGE, ...baseCookieOptions(request) };
}

export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function setCsrfCookie(response: NextResponse, token: string, request?: NextRequest) {
  response.cookies.set(CSRF_COOKIE_NAME, token, getCsrfCookieOptions(request));
}

export function clearCsrfCookie(response: NextResponse, request?: NextRequest) {
  response.cookies.set(CSRF_COOKIE_NAME, '', { ...getCsrfCookieOptions(request), maxAge: 0 });
}

export function validateCsrf(request: NextRequest): boolean {
  const headerToken = request.headers.get('x-csrf-token');
  const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  if (!headerToken || !cookieToken) return false;
  if (headerToken.length !== cookieToken.length) return false;
  let diff = 0;
  for (let i = 0; i < headerToken.length; i++) {
    diff |= headerToken.charCodeAt(i) ^ cookieToken.charCodeAt(i);
  }
  return diff === 0;
}

/** The account's "save login info" preference (default ON). */
export async function getSaveLoginInfo(userId: string): Promise<boolean> {
  const sec = await prisma.userSecurity
    .findUnique({ where: { userId }, select: { saveLoginInfo: true } })
    .catch(() => null);
  return sec?.saveLoginInfo ?? true;
}

export async function createSession(
  userId: string,
  userAgent?: string,
  ipAddress?: string,
  adminRole?: string,
  shortTerm?: boolean,
): Promise<{ token: string; sessionId: string; refreshToken: string; saveLoginInfo: boolean }> {
  const now = new Date();
  const saveLoginInfo = await getSaveLoginInfo(userId);
  // saveLoginInfo OFF: idle-capped session (1h sliding window) regardless of
  // the login method.
  // Short-term session: 3 days (for OTP/magic link login)
  // Long-term session: 30 days (for password login)
  const maxAge = !saveLoginInfo
    ? SAVE_LOGIN_IDLE_MS / 1000
    : shortTerm
      ? 60 * 60 * 24 * 3
      : REFRESH_COOKIE_MAX_AGE;
  const expiresAt = new Date(now.getTime() + maxAge * 1000);

  const refreshToken = generateRefreshToken();
  const refreshTokenHash = await hashRefreshToken(refreshToken);

  // SECURITY: the signed access JWT is deliberately NOT persisted (the old
  // sessions.token column leaked live bearer tokens into the database). The
  // JWT is stateless — only the rotating refresh-token hash lives in storage.
  const session = await prisma.userSession.create({
    data: {
      userId,
      expiresAt,
      userAgent,
      ipAddress,
      location: currentRequestOrigin()?.location ?? null,
      tokenHash: refreshTokenHash,
      deviceName: userAgent?.split(')')[0]?.split('(')[1]?.trim().slice(0, 120) || null } });

  const token = await signToken(userId, session.id, adminRole);

  // Registry of known devices for this account (dashboard "your devices" list).
  prisma.userDevice
    .create({
      data: {
        userId,
        deviceName: session.deviceName,
        userAgent: userAgent || null,
        ipAddress: ipAddress || null,
        location: session.location,
        status: 'active',
        lastUsedAt: now } })
    .catch(() => {});

  await seedSessionState(session.id, userId, ipAddress || null, userAgent || null);

  return { token, sessionId: session.id, refreshToken, saveLoginInfo };
}

/** The account's login address, as shown in session identities. */
export async function userEmailForSession(userId: string, username: string | null): Promise<string> {
  if (username) return tirbeoEmailFor(username);
  const row = await prisma.userEmail.findFirst({
    where: { userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { address: true } });
  return row?.address || `${userId}@${TIRBEO_MAIL_DOMAIN}`;
}

export async function issueAccessAndRefreshTokens(sessionId: string) {
  const session = await prisma.userSession.findUnique({ where: { id: sessionId } });
  if (!session) return null;
  const token = await signToken(session.userId, session.id);
  return { token, sessionId: session.id };
}

export async function seedSessionState(sessionId: string, userId: string, ip: string | null, ua: string | null) {
  await saveSessionState({
    sessionId,
    userId,
    revoked: false,
    createdAt: Date.now(),
    lastSeenIp: ip || null,
    deviceInfo: ua || null }).catch(() => {});
}

/**
 * Refreshing reuses the existing session row, so `ipAddress`/`userAgent` on it
 * mean "signed in from" — the new-IP checks in authHandlers compare against
 * exactly that. They are deliberately not overwritten here.
 */
export async function rotateRefreshToken(refreshToken: string) {
  const presentedHash = await hashRefreshToken(refreshToken);
  const now = new Date();

  // Reuse detection (Redis-backed spent-token history).
  const spent = await isRefreshSpent(presentedHash);
  if (spent) {
    /* Every Tirbeo app on localhost shares ONE refresh cookie, so two tabs can
       present the same token a heartbeat apart: the first rotates, the second
       finds its own token already spent. That's a race, not theft. Inside a
       short grace the live session is simply re-served (and the token the
       first rotation minted is marked spent too, so that tab rides the same
       grace on its next refresh). Past the grace — or on a record with no
       trustworthy timestamp, or a dead session — it stays the theft
       signature: kill the whole session family rather than mint a fresh pair
       for a replayed token. */
    const raced = Date.now() - spent.spentAt <= REFRESH_RACE_GRACE_MS;
    const live = raced
      ? await prisma.userSession.findUnique({
          where: { id: spent.sessionId },
          include: { user: { select: { security: { select: { saveLoginInfo: true } } } } },
        }).catch(() => null)
      : null;
    if (live && !live.revokedAt && live.expiresAt >= now) return rotateFrom(live, now);
    await revokeSessionFamily(spent.sessionId);
    return null;
  }

  const session = await prisma.userSession.findFirst({
    where: { tokenHash: presentedHash },
    include: { user: { select: { security: { select: { saveLoginInfo: true } } } } } });
  if (!session) return null;

  // Idle-capped accounts: an hour of quiet ends the session here too — the
  // sliding expiresAt is the idle deadline, and a refresh must NOT extend a
  // session that has gone idle past it (the check below revokes).
  if (session.revokedAt || session.expiresAt < now) {
    // An expired/revoked session is killed here and the caller gets a 401 —
    // rotation ALWAYS reuses the same session row and no refresh path ever
    // mints a brand-new session after expiry, which is why there are no
    // 'auth.session_extended' ledger rows by design.
    await revokeSession(session.id);
    await markRefreshSpent(presentedHash, session.id);
    return null;
  }

  return rotateFrom(session, now);
}

/** The rotation itself: a new refresh token on the same session row, the
    presented hash recorded as spent, a freshly signed access token. */
async function rotateFrom(
  session: { id: string; userId: string; tokenHash: string; user?: { security?: { saveLoginInfo?: boolean } | null } | null },
  now: Date,
) {
  const saveLoginInfo = session.user?.security?.saveLoginInfo ?? true;
  const newRefreshToken = generateRefreshToken();
  const newHash = await hashRefreshToken(newRefreshToken);

  await prisma.userSession.update({
    where: { id: session.id },
    data: {
      tokenHash: newHash,
      lastUsedAt: now,
      ...(!saveLoginInfo ? { expiresAt: new Date(now.getTime() + SAVE_LOGIN_IDLE_MS) } : {}) } });

  const [token] = await Promise.all([
    signToken(session.userId, session.id),
    markRefreshSpent(session.tokenHash, session.id),
  ]);
  return { token, sessionId: session.id, refreshToken: newRefreshToken, saveLoginInfo };
}

async function revokeSessionFamily(sessionId: string): Promise<void> {
  const session = await prisma.userSession.findUnique({ where: { id: sessionId } });
  if (!session) return;
  await revokeSession(session.id);
}

export function bustSessionCache(sessionId: string) {
  sessionCache.delete(sessionId);
}

export async function revokeSession(sessionId: string): Promise<void> {
  sessionCache.delete(sessionId);
  void deleteCachedSessionIdentity(sessionId);
  // Look up the owner BEFORE the row flips to revoked, so we can push a
  // realtime revocation event to their other tabs (Pusher Channels).
  const owner = await prisma.userSession
    .findUnique({ where: { id: sessionId }, select: { userId: true } })
    .catch(() => null);
  const flipped = await prisma.userSession
    .updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), status: 'revoked' } })
    .then((r) => r.count)
    .catch(() => 0);
  if (flipped > 0 && owner?.userId) {
    logSessionEvent('auth.session_revoked', owner.userId, { sessionId, via: 'revokeSession' });
  }
  try {
    await revokeSessionState(sessionId);
  } catch {}
  if (owner?.userId) {
    try {
      const { pusherSessionRevoked } = await import('@/infrastructure/realtime/pusher-deliver');
      pusherSessionRevoked(owner.userId);
    } catch { /* pusher not configured */ }
  }
}

/**
 * Flip-to-OFF enforcement: when saveLoginInfo is turned off the policy for
 * every existing long-lived session is void, so they are revoked (the session
 * making the change is kept alive but shortened to the idle window — matching
 * the keep-current-session behavior of the existing revoke-all endpoint).
 */
export async function revokeLongLivedSessions(userId: string, keepSessionId?: string): Promise<void> {
  const now = new Date();
  const others = {
    userId,
    revokedAt: null,
    expiresAt: { gt: now },
    ...(keepSessionId ? { id: { not: keepSessionId } } : {}) };
  const toRevoke = await prisma.userSession.findMany({ where: others, select: { id: true } }).catch(() => [] as { id: string }[]);
  if (toRevoke?.length) {
    logSessionEvent('auth.session_revoked_all', userId, { count: toRevoke.length, via: 'revokeLongLivedSessions' });
  }
  await prisma.userSession
    .updateMany({ where: others, data: { revokedAt: now, status: 'revoked' } })
    .catch(() => {});
  for (const s of toRevoke || []) {
    sessionCache.delete(s.id);
    void deleteCachedSessionIdentity(s.id);
    await revokeSessionState(s.id).catch(() => {});
  }
  if (keepSessionId && !/^(cli|apikey:)/.test(keepSessionId)) {
    await prisma.userSession
      .updateMany({ where: { id: keepSessionId, revokedAt: null }, data: { expiresAt: new Date(now.getTime() + SAVE_LOGIN_IDLE_MS), lastUsedAt: now } })
      .catch(() => {});
    sessionCache.delete(keepSessionId);
    void deleteCachedSessionIdentity(keepSessionId);
  }
  if (toRevoke?.length) {
    try {
      const { pusherSessionRevoked } = await import('@/infrastructure/realtime/pusher-deliver');
      pusherSessionRevoked(userId);
    } catch { /* pusher not configured */ }
  }
}

export async function revokeSessionFamilyByUser(userId: string): Promise<void> {
  const sessions = await prisma.userSession.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
  if (sessions.length) {
    logSessionEvent('auth.session_revoked_all', userId, { count: sessions.length, via: 'revokeSessionFamilyByUser' });
  }
  await prisma.userSession
    .updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), status: 'revoked' } })
    .catch(() => {});
  await prisma.userDevice
    .updateMany({
      where: { userId, status: 'active' },
      data: { status: 'revoked' } })
    .catch(() => {});
  for (const s of sessions) {
    sessionCache.delete(s.id);
    void deleteCachedSessionIdentity(s.id);
    await revokeSessionState(s.id).catch(() => {});
  }
  // Realtime: tell every open tab this user's sessions were revoked.
  try {
    const { pusherSessionRevoked } = await import('@/infrastructure/realtime/pusher-deliver');
    pusherSessionRevoked(userId);
  } catch { /* pusher not configured */ }
}

export async function getSessionFromToken(token: string) {
  try {
    const payload = await verifyToken(token);
    if (!payload) return null;

    if ((payload as any).purpose === 'cli' && payload.sub) {
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, username: true, status: true, isAdmin: true } });
      // Blocked statuses (banned/suspended/deleted) are NOT refused here: the
      // proxy status gate is the single enforcement point and blocks every
      // non-exempt route, exactly as it already does for deactivated and
      // deletion_pending. Refusing here would also make it impossible for a
      // blocked user to read their own status or file an appeal.
      if (!user) return null;
      const email = await userEmailForSession(user.id, user.username);
      return { userId: user.id, email, sessionId: 'cli', adminRole: user.isAdmin ? 'admin' : null };
    }

    const sid = (payload as any).sid as string | undefined;
    if (sid) {
      const cached = sessionCache.get(sid);
      if (cached !== undefined) return cached;
      // Distributed cache (survives cold starts) — consult before hitting the DB.
      // Carries its own revocation veto: this entry is the one place a revoke
      // could be missed outright, since the cache clear below it is
      // fire-and-forget and the revocation marker is the durable half.
      const distributed = await withDeadline(readCachedSessionIdentity(sid), SESSION_CACHE_DEADLINE_MS);
      if (distributed?.revoked) {
        sessionCache.set(sid, null);
        void deleteCachedSessionIdentity(sid);
        return null;
      }
      if (distributed?.identity) {
        sessionCache.set(sid, distributed.identity);
        return distributed.identity;
      }
    }

    let session: any;
    try {
      /* DB_UNANSWERED rather than `null`: the deadline wrapper's own "no" is
         the same value a missing row is, and reading the two alike would make
         every genuinely-dead session a 503 that never clears. */
      const outcome = await withDeadline(
        prisma.userSession.findUnique({
          where: { id: payload.sid },
          include: { user: { select: { id: true, username: true, status: true, isAdmin: true, security: { select: { saveLoginInfo: true } } } } } }),
        SESSION_DB_DEADLINE_MS,
        DB_UNANSWERED,
      );
      if (outcome === DB_UNANSWERED) {
        console.error('[SESSION] DB lookup timed out — session state unknown (503)');
        throw new SessionUnavailableError();
      }
      session = outcome;
    } catch (e: any) {
      if (isSessionUnavailable(e)) throw e;
      console.error('[SESSION] DB query failed during session lookup:', e?.message);
      throw new SessionUnavailableError();
    }
    if (!session) {
      sessionCache.set(payload.sid, null);
      return null;
    }

    if (session.revokedAt) {
      sessionCache.set(payload.sid, null);
      await deleteCachedSessionIdentity(payload.sid);
      return null;
    }
    if (session.expiresAt < new Date()) {
      await revokeSession(session.id);
      sessionCache.delete(payload.sid);
      await deleteCachedSessionIdentity(payload.sid);
      return null;
    }

    // Track last-active lazily (max once per 5 minutes per session) so the
    // sessions list shows real "last active" data without a DB write per
    // request. Do NOT create new sessions here — this is not an auth boundary.
    if (!session.lastUsedAt || Date.now() - session.lastUsedAt.getTime() > 5 * 60 * 1000) {
      const saveLoginInfo = session.user?.security?.saveLoginInfo ?? true;
      // Idle-capped sessions slide their deadline on every touch (the request
      // path IS where the 1h idle timeout is enforced for them).
      prisma.userSession
        .updateMany({
          where: { id: session.id },
          data: saveLoginInfo ? { lastUsedAt: new Date() } : { lastUsedAt: new Date(), expiresAt: new Date(Date.now() + SAVE_LOGIN_IDLE_MS) } })
        .catch(() => {});
      // Throttled alongside the session row (same 5-minute window). Skipped
      // when the session has no device name: matching on null would stamp
      // every nameless device of the account instead of this one.
      if (session.deviceName) {
        prisma.userDevice
          .updateMany({
            where: { userId: session.userId, status: 'active', deviceName: session.deviceName },
            data: { lastUsedAt: new Date() } })
          .catch(() => {});
      }
    }

    // Fast revocation check via Redis when available — bounded so a stalled
    // Redis can't add minutes of latency to every request.
    const state = await withDeadline(getSessionState(session.id), SESSION_CACHE_DEADLINE_MS);
    if (state && state.revoked) {
      sessionCache.set(payload.sid, null);
      await deleteCachedSessionIdentity(payload.sid);
      return null;
    }

    const user = session.user;
    if (!user) {
      sessionCache.set(payload.sid, null);
      return null;
    }

    // Resolve the identity even for banned/suspended/deleted accounts. The
    // proxy status gate remains the enforcement point (it blocks every
    // non-exempt route and revokes sessions for `deleted`), which is the same
    // contract deactivated/deletion_pending already rely on. Without this, a
    // blocked user could not read /api/user/account-state or appeal.
    // NOTE: the WS server also resolves through here, so blocked sockets
    // authenticate; they receive no data beyond what the gate permits.
    const email = await userEmailForSession(user.id, user.username);
    const result = { userId: user.id, email, sessionId: session.id, adminRole: user.isAdmin ? 'admin' : null };
    sessionCache.set(payload.sid, result);
    void setCachedSessionIdentity(payload.sid, result);
    return result;
  } catch (e: any) {
    // "Could not look" outranks the blanket guard below: it must reach the
    // caller as a 503, not be flattened into the 401 that `null` becomes.
    if (isSessionUnavailable(e)) throw e;
    console.error('[SESSION] getSessionFromToken error:', e?.message || e);
    return null;
  }
}

// Throttle the lazy device-account upsert (max once per 5 min per device+user)
// so authenticated traffic doesn't turn into a DB write per request.
const rememberedRecently = new Set<string>();

function markRemembered(deviceId: string, userId: string) {
  const key = `${deviceId}:${userId}`;
  rememberedRecently.add(key);
  setTimeout(() => rememberedRecently.delete(key), 5 * 60 * 1000).unref?.();
}

export async function getSessionFromRequest(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await getSessionFromToken(token);
  if (session && session.userId && session.sessionId !== 'cli') {
    // Lazy "remember this account on this device": any authenticated request
    // from a browser with a __device cookie registers the signed-in account in
    // the account switcher (covers every login path — OAuth, OTP, passkey…).
    const deviceId = request.cookies.get(DEVICE_COOKIE_NAME)?.value;
    if (deviceId && /^[a-f0-9]{64}$/.test(deviceId) && !wasRecentlyRemoved(deviceId, session.userId)) {
      const key = `${deviceId}:${session.userId}`;
      if (!rememberedRecently.has(key)) {
        markRemembered(deviceId, session.userId);
        rememberDeviceAccount(deviceId, session.userId).catch(() => {});
      }
    }
  }
  return session;
}

export function setSessionCookie(
  response: NextResponse,
  token: string,
  refreshToken?: string,
  request?: NextRequest,
  opts?: { shortSession?: boolean },
) {
  response.cookies.set(COOKIE_NAME, token, getAccessCookieOptions(request));
  const csrfToken = generateCsrfToken();
  setCsrfCookie(response, csrfToken, request);
  if (refreshToken) {
    response.cookies.set(REFRESH_COOKIE_NAME, refreshToken, getRefreshCookieOptions(request, opts?.shortSession));
  }
  // Ensure the device cookie exists so multi-account switching can remember
  // this account on this device. Pass `request` from login/refresh handlers.
  if (request) {
    ensureDeviceId(request, response);
  }
}

export function clearSessionCookie(response: NextResponse, request?: NextRequest) {
  response.cookies.set(COOKIE_NAME, '', { ...getAccessCookieOptions(request), maxAge: 0 });
  response.cookies.set(REFRESH_COOKIE_NAME, '', { ...getRefreshCookieOptions(request), maxAge: 0 });
  clearCsrfCookie(response, request);
}
