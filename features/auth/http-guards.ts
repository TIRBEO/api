import { NextRequest, NextResponse } from 'next/server';
import { createSession, revokeSession, setSessionCookie, clearSessionCookie, getSessionFromToken, generateCsrfToken, setCsrfCookie, clearCsrfCookie, validateCsrf, isSessionUnavailable } from '@/features/auth/session';
import { COOKIE_NAME } from '@/features/auth/jwt';
import { jsonUnauthorized, jsonForbidden, jsonSessionUnavailable } from '@/shared/response';
import { permissionLabel, resolveStaff, type Permission, type PermissionSet, type StaffIdentity } from '@/features/auth/roles';

// IP-level blocking is delegated to Cloudflare (WAF / rate rules) — the API
// only enforces account-status blocks, so a flagged network can never lock
// a real user out of their own account.

/** A session that was accepted because of what its account is allowed to do.
 *  `adminRole` stays the role string for callers that only ever log it; the
 *  powers themselves are in `permissions`, resolved once per request. */
export type StaffSession = {
  userId: string;
  email: string;
  adminRole: string;
  staff: StaffIdentity;
  permissions: PermissionSet;
};

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

/** The role key an account holds, or null when it is not staff. A legacy
 *  `is_admin` account with no role row reads as `admin` — see roles.ts. */
export async function getAdminRole(userId: string): Promise<string | null> {
  const staff = await resolveStaff(userId);
  return staff?.staff.role ?? null;
}

export async function isAdmin(request: NextRequest) {
  // A lookup that could not be made is "not an admin" for this caller: it is
  // only ever asked to grant a privilege, never to end a session.
  const session = await getSession(request).catch(() => null);
  if (!session) return false;
  const role = await getAdminRole(session.userId);
  return role != null;
}

/** Any staff role, whatever it may do. Use this for a screen whose only
 *  question is "are you on the team"; use `requirePermission` when the request
 *  changes something. */
export async function requireAdmin(request: NextRequest): Promise<StaffSession | NextResponse> {
  const session = await getSessionOrResponse(request);
  if (session instanceof NextResponse) return session;
  const staff = await resolveStaff(session.userId);
  if (!staff) return jsonForbidden();
  return { ...session, adminRole: staff.staff.role, staff: staff.staff, permissions: staff.permissions };
}

/**
 * The gate the console is actually built on: this request needs this power.
 *
 * A refusal names the permission, because "forbidden" tells a staff member
 * nothing about what to ask an owner for, and the catalogue is short enough
 * that the sentence is useful rather than a leak. `console.read` is implied —
 * an account with no role row at all has no powers, so every permission check
 * is also a staff check.
 */
export async function requirePermission(
  request: NextRequest,
  permission: Permission,
): Promise<StaffSession | NextResponse> {
  const session = await getSessionOrResponse(request);
  if (session instanceof NextResponse) return session;
  const staff = await resolveStaff(session.userId);
  if (!staff) return jsonForbidden();
  if (staff.permissions[permission] !== true) {
    return jsonForbidden(`This needs the "${permissionLabel(permission)}" permission, which your role does not have.`);
  }
  return { ...session, adminRole: staff.staff.role, staff: staff.staff, permissions: staff.permissions };
}

/** The one power that cannot be given out by an override: the roster. Ranks
 *  decide this rather than the permission set so that a mis-edited delta in
 *  `app_config` cannot make somebody an owner. */
export async function requireOwner(request: NextRequest): Promise<StaffSession | NextResponse> {
  const session = await requirePermission(request, 'staff.manage');
  if (session instanceof NextResponse) return session;
  if (session.staff.role !== 'owner') {
    return jsonForbidden('Only an owner can change the staff roster.');
  }
  return session;
}

export { createSession, revokeSession, setSessionCookie, clearSessionCookie, COOKIE_NAME, generateCsrfToken, setCsrfCookie, clearCsrfCookie, validateCsrf, isSessionUnavailable };
