import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { createSession, revokeSession, setSessionCookie, clearSessionCookie, getSessionFromToken, generateCsrfToken, setCsrfCookie, clearCsrfCookie, validateCsrf, isSessionUnavailable } from '@/features/auth/session';
import { COOKIE_NAME } from '@/features/auth/jwt';
import { jsonUnauthorized, jsonForbidden, jsonSessionUnavailable } from '@/shared/response';

const ROLE_HIERARCHY: Record<string, number> = {
  editor: 1,
  manager: 2,
  admin: 3,
  super_admin: 4,
};

// IP-level blocking is delegated to Cloudflare (WAF / rate rules) — the API
// only enforces account-status blocks, so a flagged network can never lock
// a real user out of their own account.

export async function getSession(request: NextRequest) {
  // Try cookie auth first — wrapped in try/catch so DB errors don't prevent API key fallback
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    try {
      const session = await getSessionFromToken(token);
      if (session) return session;
    } catch (e: any) {
      // "We could not tell" must not be flattened into "no session" — it has
      // to reach the response layer as a 503. See SessionUnavailableError.
      if (isSessionUnavailable(e)) throw e;
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
        if (isSessionUnavailable(e)) throw e;
        console.error('[SESSION] Bearer auth failed:', e?.message || e);
      }
    }
  }

  return null;
}

/**
 * `getSession` plus the two answers a caller must not invent on its own:
 * 401 when there is genuinely no session, 503 when the session could not be
 * looked up. Handlers that use this get the distinction for free; handlers
 * that call `getSession` directly get the throw and the route layer maps it.
 */
export async function getSessionOrResponse(request: NextRequest): Promise<{ userId: string; email: string } | NextResponse> {
  try {
    const session = await getSession(request);
    return session ?? jsonUnauthorized();
  } catch (e) {
    if (isSessionUnavailable(e)) return jsonSessionUnavailable(request);
    throw e;
  }
}

export async function requireSession(request: NextRequest): Promise<{ userId: string; email: string } | NextResponse> {
  return getSessionOrResponse(request);
}

export async function getAdminRole(userId: string): Promise<string | null> {
  try {
    // Consolidated schema: adminRole column gone → boolean isAdmin, mapped to
    // the legacy 'admin' role string so callers keep the same API shape.
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    return user?.isAdmin ? 'admin' : null;
  } catch (e: any) {
    console.error('[SESSION] getAdminRole failed:', e?.message || e);
    return null;
  }
}

export async function isAdmin(request: NextRequest) {
  // A lookup that could not be made is "not an admin" for this caller: it is
  // only ever asked to grant a privilege, never to end a session.
  const session = await getSession(request).catch(() => null);
  if (!session) return false;
  const role = await getAdminRole(session.userId);
  return role != null;
}

export async function requireAdmin(request: NextRequest): Promise<{ userId: string; email: string; adminRole: string } | NextResponse> {
  const session = await getSessionOrResponse(request);
  if (session instanceof NextResponse) return session;
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
  const session = await getSessionOrResponse(request);
  if (session instanceof NextResponse) return session;
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

export { createSession, revokeSession, setSessionCookie, clearSessionCookie, COOKIE_NAME, generateCsrfToken, setCsrfCookie, clearCsrfCookie, validateCsrf, isSessionUnavailable };
