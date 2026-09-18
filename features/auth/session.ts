import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { signToken, verifyToken, COOKIE_NAME } from '@/features/auth/jwt';
import { DEVICE_COOKIE_NAME, ensureDeviceId, rememberDeviceAccount, wasRecentlyRemoved } from '@/features/auth/device-accounts';
import {
  hashRefreshToken,
  generateRefreshToken,
  markRefreshSpent,
  isRefreshSpent,
  saveSessionState,
  getSessionState,
  revokeSessionState,
  getCachedSessionIdentity,
  setCachedSessionIdentity,
  deleteCachedSessionIdentity,
} from '@/features/auth/redis';
import { createTtlCache } from '@/infrastructure/cache';

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

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export const COOKIE_DOMAIN = process.env.NEXT_PUBLIC_COOKIE_DOMAIN || '.tirbeo.app';

const ACCESS_COOKIE_MAX_AGE = 60 * 15;
const REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export const REFRESH_COOKIE_NAME = '__refresh';

const IS_PROD = process.env.NODE_ENV !== 'development';

/**
 * Determine the correct cookie domain for the current request.
 * In production use COOKIE_DOMAIN (.tirbeo.app) so the session is shared
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

function getAccessCookieOptions(request?: NextRequest) {
  const domain = getCookieDomain(request);
  return {
    httpOnly: true,
    secure: IS_PROD && !!domain,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: ACCESS_COOKIE_MAX_AGE,
    ...(domain ? { domain } : {}),
  };
}

function getRefreshCookieOptions(request?: NextRequest) {
  const domain = getCookieDomain(request);
  return {
    httpOnly: true,
    secure: IS_PROD && !!domain,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: REFRESH_COOKIE_MAX_AGE,
    ...(domain ? { domain } : {}),
  };
}

const CSRF_COOKIE_NAME = '__csrf';
function getCsrfCookieOptions(request?: NextRequest) {
  const domain = getCookieDomain(request);
  return {
    httpOnly: false,
    secure: IS_PROD && !!domain,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: ACCESS_COOKIE_MAX_AGE,
    ...(domain ? { domain } : {}),
  };
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

export async function createSession(
  userId: string,
  userAgent?: string,
  ipAddress?: string,
  adminRole?: string,
  shortTerm?: boolean,
): Promise<{ token: string; sessionId: string; refreshToken: string }> {
  const now = new Date();
  // Short-term session: 3 days (for OTP/magic link login)
  // Long-term session: 30 days (for password login)
  const maxAge = shortTerm ? 60 * 60 * 24 * 3 : REFRESH_COOKIE_MAX_AGE;
  const expiresAt = new Date(now.getTime() + maxAge * 1000);

  const refreshToken = generateRefreshToken();
  const refreshTokenHash = await hashRefreshToken(refreshToken);
  const refreshExpiresAt = new Date(now.getTime() + maxAge * 1000);

  const session = await prisma.session.create({
    data: {
      userId,
      expiresAt,
      userAgent,
      ipAddress,
      refreshTokenHash,
      refreshTokenIssuedAt: now,
      refreshExpiresAt,
    },
  });

  const token = await signToken(userId, session.id, adminRole);

  await prisma.session.update({
    where: { id: session.id },
    data: { token },
  });

  await seedSessionState(session.id, userId, ipAddress || null, userAgent || null);

  // Update last login tracking fields on User
  await prisma.user.update({
    where: { id: userId },
    data: {
      lastLoginAt: now,
      lastLoginIp: ipAddress || null,
      loginCount: { increment: 1 },
      lastActiveAt: now,
    },
  }).catch(() => {});

  return { token, sessionId: session.id, refreshToken };
}

export async function issueAccessAndRefreshTokens(sessionId: string) {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
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
    deviceInfo: ua || null,
  }).catch(() => {});
}

export async function rotateRefreshToken(refreshToken: string, ipAddress?: string, userAgent?: string) {
  const presentedHash = await hashRefreshToken(refreshToken);
  const now = new Date();

  // Reuse detection (DB-backed one-deep + Redis deeper history).
  const isSpent = await isRefreshSpent(presentedHash);
  if (isSpent) {
    // Check if session is still active — if so, this is likely a concurrent
    // request with the old token (both tabs/requests hitting refresh simultaneously).
    const session = await prisma.session.findUnique({
      where: { id: isSpent },
      select: { id: true, userId: true, refreshTokenHash: true, expiresAt: true, status: true, revokedAt: true },
    });

    if (session && session.expiresAt > new Date() && session.status !== 'revoked' && !session.revokedAt && session.refreshTokenHash) {
      // Session still active — this is a concurrent request with the old token.
      // Issue a new token pair using the current session state.
      const newRefreshToken = generateRefreshToken();
      const [newAccessToken, newRefreshHash] = await Promise.all([
        signToken(session.userId, isSpent),
        hashRefreshToken(newRefreshToken),
      ]);
      await Promise.all([
        prisma.session.update({
          where: { id: isSpent },
          data: { refreshTokenHash: newRefreshHash, lastUsedAt: new Date() },
        }),
        markRefreshSpent(presentedHash, isSpent),
      ]);
      return { token: newAccessToken, refreshToken: newRefreshToken, sessionId: isSpent };
    }

    // Session expired or revoked — revoke the family
    await revokeSessionFamily(isSpent);
    return null;
  }

  const session = await prisma.session.findUnique({ where: { refreshTokenHash: presentedHash } });
  if (!session) return null;

  if (session.status === 'revoked' || session.revokedAt || session.refreshExpiresAt! < now) {
    await revokeSession(session.id);
    if (isSpent === null) await markRefreshSpent(presentedHash, session.id);
    return null;
  }

  // Reuse: presented token is the previously-spent one (still stored on the row).
  if (session.previousRefreshTokenHash && presentedHash === session.previousRefreshTokenHash) {
    await revokeSessionFamily(session.id);
    await markRefreshSpent(presentedHash, session.id);
    return null;
  }

  const newRefreshToken = generateRefreshToken();
  const newHash = await hashRefreshToken(newRefreshToken);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_COOKIE_MAX_AGE * 1000);

  await prisma.session.update({
    where: { id: session.id },
    data: {
      refreshTokenHash: newHash,
      previousRefreshTokenHash: session.refreshTokenHash,
      refreshTokenIssuedAt: now,
      refreshExpiresAt,
      lastUsedAt: now,
    },
  });

  const [token] = await Promise.all([
    signToken(session.userId, session.id),
    markRefreshSpent(presentedHash, session.id),
  ]);
  return { token, sessionId: session.id, refreshToken: newRefreshToken };
}

async function revokeSessionFamily(sessionId: string): Promise<void> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
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
  const owner = await prisma.session
    .findUnique({ where: { id: sessionId }, select: { userId: true } })
    .catch(() => null);
  await prisma.session
    .updateMany({
      where: { id: sessionId, status: { not: 'revoked' } },
      data: { status: 'revoked', revokedAt: new Date(), refreshTokenHash: null, previousRefreshTokenHash: null },
    })
    .catch(() => {});
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

export async function revokeSessionFamilyByUser(userId: string): Promise<void> {
  await prisma.session
    .updateMany({
      where: { userId, status: { not: 'revoked' } },
      data: { status: 'revoked', revokedAt: new Date(), refreshTokenHash: null, previousRefreshTokenHash: null },
    })
    .catch(() => {});
  const sessions = await prisma.session.findMany({ where: { userId }, select: { id: true } });
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
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || user.isBanned || user.isSuspended || user.deletedAt) return null;
      return { userId: user.id, email: user.email, sessionId: 'cli', adminRole: user.adminRole };
    }

    const sid = (payload as any).sid as string | undefined;
    if (sid) {
      const cached = sessionCache.get(sid);
      if (cached !== undefined) return cached;
      // Distributed cache (survives cold starts) — consult before hitting the DB.
      const distributed = await withDeadline(getCachedSessionIdentity(sid), SESSION_CACHE_DEADLINE_MS);
      if (distributed) {
        sessionCache.set(sid, distributed);
        return distributed;
      }
    }

    let session: any = null;
    try {
      session = await withDeadline(
        prisma.session.findUnique({
          where: { id: payload.sid },
          include: { user: { select: { id: true, email: true, adminRole: true, isBanned: true, isSuspended: true } } },
        }),
        SESSION_DB_DEADLINE_MS,
      );
      if (session === null) {
        // Deadline hit (DB unreachable) — fail closed FAST instead of hanging.
        console.error('[SESSION] DB lookup timed out — rejecting session (fail closed, fast)');
        return null;
      }
    } catch (e: any) {
      console.error('[SESSION] DB query failed during session lookup:', e?.message);
      // When DB is down, fail closed — reject the session rather than
      // allowing unauthenticated access. The cached identity may still
      // serve stale data, which is acceptable for read-heavy paths.
      return null;
    }
    if (!session) {
      sessionCache.set(payload.sid, null);
      return null;
    }

    if (session.status === 'revoked' || session.revokedAt) {
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

    // Refresh the access token when it is close to expiring (proactive).
    // Track last-active lazily (max once per 5 minutes per session) so the
    // sessions list shows real "last active" data without a DB write per
    // request. Do NOT create new sessions here — this is not an auth boundary.
    if (!session.lastUsedAt || Date.now() - session.lastUsedAt.getTime() > 5 * 60 * 1000) {
      prisma.session
        .updateMany({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {});
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
    if (!user || user.isBanned || user.isSuspended || user.deletedAt) {
      sessionCache.set(payload.sid, null);
      return null;
    }

    const result = { userId: user.id, email: user.email, sessionId: session.id, adminRole: user.adminRole };
    sessionCache.set(payload.sid, result);
    void setCachedSessionIdentity(payload.sid, result);
    return result;
  } catch (e: any) {
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

export function setSessionCookie(response: NextResponse, token: string, refreshToken?: string, request?: NextRequest) {
  response.cookies.set(COOKIE_NAME, token, getAccessCookieOptions(request));
  const csrfToken = generateCsrfToken();
  setCsrfCookie(response, csrfToken, request);
  if (refreshToken) {
    response.cookies.set(REFRESH_COOKIE_NAME, refreshToken, getRefreshCookieOptions(request));
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
