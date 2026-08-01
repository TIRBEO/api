import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../db/prisma';
import { signToken, verifyToken, COOKIE_NAME } from './jwt';

export const COOKIE_DOMAIN = process.env.NEXT_PUBLIC_COOKIE_DOMAIN || '.tirbeo.app';

const SESSION_COOKIE_OPTIONS: {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'none';
  path: string;
  maxAge: number;
  domain?: string;
} = {
  httpOnly: true,
  secure: process.env.NODE_ENV !== 'development',
  sameSite: 'lax',
  path: '/',
  maxAge: 60 * 60 * 24 * 7,
  ...(process.env.NODE_ENV !== 'development' ? { domain: COOKIE_DOMAIN } : {}),
};

const CSRF_COOKIE_NAME = '__csrf';
const CSRF_COOKIE_OPTIONS = {
  httpOnly: false, // JS must read this to send as header
  secure: process.env.NODE_ENV !== 'development',
  sameSite: 'strict' as const,
  path: '/',
  maxAge: 60 * 60 * 24 * 7,
  ...(process.env.NODE_ENV !== 'development' ? { domain: COOKIE_DOMAIN } : {}),
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
  // Constant-time comparison to prevent timing attacks
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
  adminRole?: string
): Promise<{ token: string; sessionId: string }> {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const session = await prisma.session.create({
    data: { userId, expiresAt, userAgent, ipAddress },
  });

  const token = await signToken(userId, session.id, adminRole);

  await prisma.session.update({
    where: { id: session.id },
    data: { token },
  });

  return { token, sessionId: session.id };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
}

export async function getSessionFromToken(token: string) {
  try {
    const payload = await verifyToken(token);
    if (!payload) return null;

    // CLI tokens have purpose='cli' and no sid — verify JWT and return user directly
    if ((payload as any).purpose === 'cli' && payload.sub) {
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || user.isBanned || user.isSuspended) return null;
      return { userId: user.id, email: user.email, sessionId: 'cli' };
    }

    const session = await prisma.session.findFirst({ where: { id: payload.sid, token } });
    if (!session) return null;

    if (session.expiresAt < new Date()) {
      await revokeSession(session.id);
      return null;
    }

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

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
  // Also set CSRF cookie (Double Submit Cookie pattern)
  const csrfToken = generateCsrfToken();
  setCsrfCookie(response, csrfToken);
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, '', { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
  clearCsrfCookie(response);
}
