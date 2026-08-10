import { NextRequest, NextResponse } from 'next/server';
import { getSession, getAdminRole, roleAtLeast } from './session';
import { jsonUnauthorized, jsonForbidden, jsonTooManyRequests } from './response';
import { checkRateLimit } from './auth/rate-limit';

/**
 * Role hierarchy levels for comparison
 */
export const ROLE_LEVELS: Record<string, number> = {
  user: 0,
  editor: 1,
  manager: 2,
  admin: 3,
  super_admin: 4,
};

/**
 * Get the numeric level for a role
 */
export function getRoleLevel(role: string | null | undefined): number {
  if (!role) return 0;
  return ROLE_LEVELS[role.toLowerCase()] ?? 0;
}

/**
 * Check if user role meets minimum requirement
 */
export function hasMinimumRole(userRole: string | null | undefined, minimumRole: string): boolean {
  return getRoleLevel(userRole) >= getRoleLevel(minimumRole);
}

/**
 * Authenticated session with role info
 */
export interface AuthSession {
  userId: string;
  email: string;
  adminRole: string | null;
}

/**
 * Protected route handler type
 */
type ProtectedHandler = (
  request: NextRequest,
  session: AuthSession
) => Promise<NextResponse> | NextResponse;

/**
 * Options for role protection
 */
interface RoleGuardOptions {
  /** Minimum role required (e.g., 'admin', 'super_admin') */
  minimumRole?: string;
  /** Required role exactly (e.g., 'super_admin') */
  exactRole?: string;
  /** Allowed roles (e.g., ['admin', 'manager']) */
  allowedRoles?: string[];
  /** Skip IP block check */
  skipIpCheck?: boolean;
  /** Custom rate limit for this endpoint (requests per minute) */
  rateLimit?: number;
  /** Skip rate limiting */
  skipRateLimit?: boolean;
}

/**
 * Wrapper that adds role-based protection to a route handler.
 * 
 * @example
 * // Require any admin
 * export const GET = withRole(handler);
 * 
 * @example
 * // Require super_admin only
 * export const POST = withRole(handler, { minimumRole: 'super_admin' });
 * 
 * @example
 * // Require specific roles
 * export const DELETE = withRole(handler, { allowedRoles: ['super_admin'] });
 */
export function withRole(
  handler: ProtectedHandler,
  options: RoleGuardOptions = {}
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    // Get session (IP blocking is handled by proxy middleware)
    const session = await getSession(request);
    if (!session) {
      return jsonUnauthorized();
    }

    // Get user's role
    const userRole = await getAdminRole(session.userId);

    // Check role requirements
    if (options.exactRole) {
      if (userRole !== options.exactRole) {
        return jsonForbidden(`Requires ${options.exactRole} role`);
      }
    } else if (options.allowedRoles) {
      if (!userRole || !options.allowedRoles.includes(userRole)) {
        return jsonForbidden(`Requires one of: ${options.allowedRoles.join(', ')}`);
      }
    } else if (options.minimumRole) {
      if (!hasMinimumRole(userRole, options.minimumRole)) {
        return jsonForbidden(`Requires ${options.minimumRole} or higher role`);
      }
    } else {
      // Default: require any admin role
      if (!userRole) {
        return jsonForbidden('Admin access required');
      }
    }

    // Apply role-based rate limiting
    if (!options.skipRateLimit) {
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() 
        || request.headers.get('x-real-ip') 
        || 'unknown';
      const route = request.nextUrl.pathname;
      const isAdmin = userRole != null;
      
      const allowed = await checkRateLimit(
        `${ip}:${route}`,
        true, // isAuthenticated
        options.rateLimit,
        isAdmin,
        session.userId,
        userRole || undefined
      );
      
      if (!allowed) {
        return jsonTooManyRequests();
      }
    }

    // Call the handler with the authenticated session
    return handler(request, {
      userId: session.userId,
      email: session.email,
      adminRole: userRole,
    });
  };
}

/**
 * Shorthand for requiring super_admin role
 */
export function withSuperAdmin(handler: ProtectedHandler) {
  return withRole(handler, { minimumRole: 'super_admin' });
}

/**
 * Shorthand for requiring admin role (admin or super_admin)
 */
export function withAdmin(handler: ProtectedHandler) {
  return withRole(handler, { minimumRole: 'admin' });
}

/**
 * Shorthand for requiring manager role or higher
 */
export function withManager(handler: ProtectedHandler) {
  return withRole(handler, { minimumRole: 'manager' });
}

/**
 * Shorthand for requiring editor role or higher
 */
export function withEditor(handler: ProtectedHandler) {
  return withRole(handler, { minimumRole: 'editor' });
}

/**
 * Utility to create a response with role error
 */
export function roleErrorResponse(role: string | null, required: string): NextResponse {
  if (!role) {
    return jsonForbidden('Admin access required');
  }
  return jsonForbidden(`Requires ${required} role, you have ${role}`);
}
