import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../db/prisma';
import { signToken, verifyToken, COOKIE_NAME } from './jwt';
import { DEVICE_COOKIE_NAME, ensureDeviceId, rememberDeviceAccount, wasRecentlyRemoved } from './device-accounts';
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
} from './redis';
import { createTtlCache } from '../cache';

// Short-TTL in-memory cache for session lookups. Authenticated requests hit
// this instead of the DB on every call (the DB lookup is the dominant cost,
// especially on cold connections). Busted on revoke. A few seconds of grace
// after revocation is acceptable for a large per-request latency win.
const sessionCache = createTtlCache<{ userId: string; email: string; sessionId: string; adminRole: string | null } | null>(20_000, 10_000, 'session');

export const COOKIE_DOMAIN = process.env.NEXT_PUBLIC_COOKIE_DOMAIN || '.tirbeo.app';

const ACCESS_COOKIE_MAX_AGE = 60 * 15;
const REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export const REFRESH_COOKIE_NAME = '__refresh';

const IS_PROD = process.env.NODE_ENV !== 'development';

/**
 * Determine the correct cookie domain for the current request.
 * In production with a real domain, use COOKIE_DOMAIN (e.g. .tirbeo.app).
 * On localhost, always use 'localhost' so cookies are shared across ports.
 */
function getCookieDomain(request?: NextRequest): string | undefined {
  const host = request?.headers?.get('host') || '';
  const isLocalhost = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  if (isLocalhost) return 'localhost';
  if (IS_PROD) return COOKIE_DOMAIN;
  return 'localhost';
}

function getAccessCookieOptions(request?: NextRequest) {
  return {
    httpOnly: true,
    secure: IS_PROD && !getCookieDomain(request)?.includes('localhost'),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: ACCESS_COOKIE_MAX_AGE,
    domain: getCookieDomain(request),
  };
}

function getRefreshCookieOptions(request?: NextRequest) {
  return {
    httpOnly: true,
    secure: IS_PROD && !getCookieDomain(request)?.includes('localhost'),
    sameSite: 'lax' as const,
    path: '/api/auth/refresh',
    maxAge: REFRESH_COOKIE_MAX_AGE,
    domain: getCookieDomain(request),
  };
}

const CSRF_COOKIE_NAME = '__csrf';
function getCsrfCookieOptions(request?: NextRequest) {
  return {
    httpOnly: false,
    secure: IS_PROD && !getCookieDomain(request)?.includes('localhost'),
    sameSite: 'strict' as const,
    path: '/',
    maxAge: ACCESS_COOKIE_MAX_AGE,
    domain: getCookieDomain(request),
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
): Promise<{ token: string; sessionId: string; refreshToken: string }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_COOKIE_MAX_AGE * 1000);

  const refreshToken = generateRefreshToken();
  const refreshTokenHash = await hashRefreshToken(refreshToken);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_COOKIE_MAX_AGE * 1000);

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

  await markRefreshSpent(presentedHash, session.id);

  const token = await signToken(session.userId, session.id);
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
  await prisma.session
    .updateMany({
      where: { id: sessionId, status: { not: 'revoked' } },
      data: { status: 'revoked', revokedAt: new Date(), refreshTokenHash: null, previousRefreshTokenHash: null },
    })
    .catch(() => {});
  try {
    await revokeSessionState(sessionId);
  } catch {}
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
      const distributed = await getCachedSessionIdentity(sid);
      if (distributed) {
        sessionCache.set(sid, distributed);
        return distributed;
      }
    }

    let session: any = null;
    try {
      session = await prisma.session.findUnique({
        where: { id: payload.sid },
        include: { user: { select: { id: true, email: true, adminRole: true, isBanned: true, isSuspended: true } } },
      });
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

    // Fast revocation check via Redis when available.
    const state = await getSessionState(session.id);
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
