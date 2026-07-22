import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../db/prisma';
import { signToken, verifyToken, COOKIE_NAME } from './jwt';

const COOKIE_DOMAIN = process.env.NEXT_PUBLIC_COOKIE_DOMAIN || '.tirbeo.app';

const COOKIE_OPTIONS: {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'none';
  path: string;
  maxAge: number;
  domain?: string;
} = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 60 * 60 * 24 * 7,
  domain: COOKIE_DOMAIN,
};

export async function createSession(
  userId: string,
  userAgent?: string,
  ipAddress?: string
): Promise<{ token: string; sessionId: string }> {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const session = await prisma.session.create({
    data: { userId, expiresAt, userAgent, ipAddress },
  });

  const token = await signToken(userId, session.id);

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
  const payload = await verifyToken(token);
  if (!payload) return null;

  const session = await prisma.session.findFirst({ where: { id: payload.sid, token } });
  if (!session || session.expiresAt < new Date()) {
    if (session) await revokeSession(session.id);
    return null;
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) return null;

  return { userId: user.id, email: user.email, sessionId: session.id };
}

export async function getSessionFromRequest(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return getSessionFromToken(token);
}

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(COOKIE_NAME, token, COOKIE_OPTIONS);
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, '', { ...COOKIE_OPTIONS, maxAge: 0 });
}
