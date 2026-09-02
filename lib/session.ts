import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { createSession, revokeSession, setSessionCookie, clearSessionCookie, getSessionFromToken, generateCsrfToken, setCsrfCookie, clearCsrfCookie, validateCsrf } from './auth/session';
import { COOKIE_NAME } from './auth/jwt';
import { authenticateApiKey } from './auth/api-key';
import { jsonUnauthorized, jsonForbidden } from './response';
import { isIpBlocked, logSecurityEvent } from './security';

const ROLE_HIERARCHY: Record<string, number> = {
  editor: 1,
  manager: 2,
  admin: 3,
  super_admin: 4,
};

async function checkIpBlock(request: NextRequest): Promise<NextResponse | null> {
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || '';
    if (!ip || ip === 'unknown') return null;
    const blocked = await isIpBlocked(ip);
    if (!blocked) return null;
    logSecurityEvent({
      request: request as unknown as Request,
      eventType: 'request.blocked_ip',
      severity: 'warning',
      details: { reason: 'Request from blocked IP', ip },
    }).catch(() => {});
    return jsonForbidden('Access blocked');
  } catch {
    return null;
  }
}

export async function getSession(request: NextRequest) {
  // Try cookie auth first — wrapped in try/catch so DB errors don't prevent API key fallback
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    try {
      const session = await getSessionFromToken(token);
      if (session) return session;
    } catch (e: any) {
      console.error('[SESSION] Cookie auth failed:', e?.message || e);
    }
  }

  // Fall back to Bearer token auth (dashboard sends Authorization: Bearer <jwt> with credentials: include)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken) {
      try {
        const session = await getSessionFromToken(bearerToken);
        if (session) return session;
      } catch (e: any) {
        console.error('[SESSION] Bearer auth failed:', e?.message || e);
      }
    }
  }

  // Fall back to API key auth — also wrapped in try/catch
  try {
    const apiKeyAuth = await authenticateApiKey(request);
    if (apiKeyAuth) {
      return { userId: apiKeyAuth.userId, email: '', sessionId: `apikey:${apiKeyAuth.keyId}` };
    }
  } catch (e: any) {
    console.error('[SESSION] API key auth failed:', e?.message || e);
  }

  return null;
}

export async function requireSession(request: NextRequest): Promise<{ userId: string; email: string } | NextResponse> {
  const blocked = await checkIpBlock(request);
  if (blocked) return blocked;
  const session = await getSession(request);
  if (!session) {
    return jsonUnauthorized();
  }
  return session;
}

export async function getAdminRole(userId: string): Promise<string | null> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { adminRole: true } });
    return user?.adminRole?.toLowerCase() || null;
  } catch (e: any) {
    console.error('[SESSION] getAdminRole failed:', e?.message || e);
    return null;
  }
}

export async function isAdmin(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return false;
  const role = await getAdminRole(session.userId);
  return role != null;
}

export async function requireAdmin(request: NextRequest): Promise<{ userId: string; email: string; adminRole: string } | NextResponse> {
  const blocked = await checkIpBlock(request);
  if (blocked) return blocked;
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();
  const role = await getAdminRole(session.userId);
  if (!role) return jsonForbidden();
  return { ...session, adminRole: role };
}

export function roleAtLeast(userRole: string, minimumRole: string): boolean {
  const userLevel = ROLE_HIERARCHY[userRole] || 0;
  const minLevel = ROLE_HIERARCHY[minimumRole] || 0;
  return userLevel >= minLevel;
}

export async function requireRole(request: NextRequest, minimumRole: string): Promise<{ userId: string; email: string; adminRole: string } | NextResponse> {
  const blocked = await checkIpBlock(request);
  if (blocked) return blocked;
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();
  const userRole = await getAdminRole(session.userId);
  if (!userRole || !roleAtLeast(userRole, minimumRole)) {
    return jsonForbidden();
  }
  return { ...session, adminRole: userRole };
}

export function canManageRole(actorRole: string, targetRole: string | null): boolean {
  if (actorRole === 'super_admin') return true;
  if (actorRole === 'admin') return targetRole !== 'super_admin';
  return false;
}

export { createSession, revokeSession, setSessionCookie, clearSessionCookie, COOKIE_NAME, generateCsrfToken, setCsrfCookie, clearCsrfCookie, validateCsrf };
