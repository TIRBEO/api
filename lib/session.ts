import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { createSession, revokeSession, setSessionCookie, clearSessionCookie, getSessionFromToken } from './auth/session';
import { COOKIE_NAME } from './auth/jwt';

const ROLE_HIERARCHY: Record<string, number> = {
  editor: 1,
  manager: 2,
  admin: 3,
  super_admin: 4,
};

export async function getSession(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return getSessionFromToken(token);
}

export async function requireSession(request: NextRequest): Promise<{ userId: string; email: string } | NextResponse> {
  const session = await getSession(request);
  if (!session) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  return session;
}

export async function getAdminRole(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { adminRole: true },
  });
  return user?.adminRole || null;
}

export async function isAdmin(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return false;
  const role = await getAdminRole(session.userId);
  return role != null;
}

export async function requireAdmin(request: NextRequest): Promise<{ userId: string; email: string; adminRole: string } | NextResponse> {
  const session = await getSession(request);
  if (!session) return new NextResponse('Unauthorized', { status: 401 });
  const role = await getAdminRole(session.userId);
  if (!role) return new NextResponse('Forbidden', { status: 403 });
  return { ...session, adminRole: role };
}

export function roleAtLeast(userRole: string, minimumRole: string): boolean {
  const userLevel = ROLE_HIERARCHY[userRole] || 0;
  const minLevel = ROLE_HIERARCHY[minimumRole] || 0;
  return userLevel >= minLevel;
}

export async function requireRole(request: NextRequest, minimumRole: string): Promise<{ userId: string; email: string; adminRole: string } | NextResponse> {
  const session = await getSession(request);
  if (!session) return new NextResponse('Unauthorized', { status: 401 });
  const userRole = await getAdminRole(session.userId);
  if (!userRole || !roleAtLeast(userRole, minimumRole)) {
    return new NextResponse('Forbidden', { status: 403 });
  }
  return { ...session, adminRole: userRole };
}

export function canManageRole(actorRole: string, targetRole: string | null): boolean {
  if (actorRole === 'super_admin') return true;
  if (actorRole === 'admin') return targetRole !== 'super_admin';
  return false;
}

export { createSession, revokeSession, setSessionCookie, clearSessionCookie, COOKIE_NAME };
