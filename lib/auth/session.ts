import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../db/prisma';
import { signToken, verifyToken, COOKIE_NAME } from './jwt';
import {
  hashRefreshToken,
  generateRefreshToken,
  markRefreshSpent,
  isRefreshSpent,
  saveSessionState,
  getSessionState,
  revokeSessionState,
} from './redis';

export const COOKIE_DOMAIN = process.env.NEXT_PUBLIC_COOKIE_DOMAIN || '.tirbeo.app';

const ACCESS_COOKIE_MAX_AGE = 60 * 15;
const REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export const REFRESH_COOKIE_NAME = '__refresh';

const IS_PROD = process.env.NODE_ENV !== 'development';

const ACCESS_COOKIE_OPTIONS: {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'none';
  path: string;
  maxAge: number;
  domain?: string;
} = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: 'lax',
  path: '/',
  maxAge: ACCESS_COOKIE_MAX_AGE,
  ...(IS_PROD ? { domain: COOKIE_DOMAIN } : {}),
};

const REFRESH_COOKIE_OPTIONS: {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'none';
  path: string;
  maxAge: number;
  domain?: string;
} = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: 'lax',
  path: '/api/auth/refresh',
  maxAge: REFRESH_COOKIE_MAX_AGE,
  ...(IS_PROD ? { domain: COOKIE_DOMAIN } : {}),
};

const CSRF_COOKIE_NAME = '__csrf';
const CSRF_COOKIE_OPTIONS = {
  httpOnly: false,
  secure: IS_PROD,
  sameSite: 'strict' as const,
  path: '/',
  maxAge: ACCESS_COOKIE_MAX_AGE,
  ...(IS_PROD ? { domain: COOKIE_DOMAIN } : {}),
};

export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function setCsrfCookie(response: NextResponse, token: string) {
  response.cookies.set(CSRF_COOKIE_NAME, token, CSRF_COOKIE_OPTIONS);
}

export function clearCsrfCookie(response: NextResponse) {
  response.cookies.set(CSRF_COOKIE_NAME, '', { ...CSRF_COOKIE_OPTIONS, maxAge: 0 });
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

export async function revokeSession(sessionId: string): Promise<void> {
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
    await revokeSessionState(s.id).catch(() => {});
  }
}

export async function getSessionFromToken(token: string) {
  try {
    const payload = await verifyToken(token);
    if (!payload) return null;

    if ((payload as any).purpose === 'cli' && payload.sub) {
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || user.isBanned || user.isSuspended) return null;
      return { userId: user.id, email: user.email, sessionId: 'cli' };
    }

    const session = await prisma.session.findUnique({ where: { id: payload.sid } });
    if (!session) return null;

    if (session.status === 'revoked' || session.revokedAt) return null;
    if (session.expiresAt < new Date()) {
      await revokeSession(session.id);
      return null;
    }

    // Fast revocation check via Redis when available.
    const state = await getSessionState(session.id);
    if (state && state.revoked) return null;

    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) return null;

    return { userId: user.id, email: user.email, sessionId: session.id };
  } catch (e: any) {
    console.error('[SESSION] getSessionFromToken error:', e?.message || e);
    return null;
  }
}

export async function getSessionFromRequest(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return getSessionFromToken(token);
}

export function setSessionCookie(response: NextResponse, token: string, refreshToken?: string) {
  response.cookies.set(COOKIE_NAME, token, ACCESS_COOKIE_OPTIONS);
  const csrfToken = generateCsrfToken();
  setCsrfCookie(response, csrfToken);
  if (refreshToken) {
    response.cookies.set(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);
  }
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, '', { ...ACCESS_COOKIE_OPTIONS, maxAge: 0 });
  response.cookies.set(REFRESH_COOKIE_NAME, '', { ...REFRESH_COOKIE_OPTIONS, maxAge: 0 });
  clearCsrfCookie(response);
}
