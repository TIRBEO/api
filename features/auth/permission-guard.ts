import { NextRequest, NextResponse } from 'next/server';
import { requirePermission, type StaffSession } from '@/features/auth/http-guards';
import { jsonTooManyRequests } from '@/shared/response';
import { checkRateLimit } from '@/features/auth/rate-limit';
import type { Permission } from '@/features/auth/roles';

/**
 * The wrapper form of `requirePermission`, for a route that reads better with
 * its requirement in the export line than on line one of the body:
 *
 *   export const GET = withPermission('tickets.read', async (request) => …)
 *
 * The old `withAdmin` wrapper asked for a *role*, against a hierarchy nothing
 * in the console could display — so `minimumRole: 'manager'` could mean
 * whatever the file it was written in felt like. A permission names the thing
 * being protected, and there is exactly one place that says who has it.
 */
type PermissionedHandler = (
  request: NextRequest,
  session: StaffSession,
) => Promise<NextResponse> | NextResponse;

export interface WithPermissionOptions {
  /** Requests per minute for this route. Staff are rate-limited too: a stolen
   *  owner token should page a phone, not browse every account. */
  rateLimit?: number;
  skipRateLimit?: boolean;
}

export function withPermission(
  permission: Permission,
  handler: PermissionedHandler,
  options: WithPermissionOptions = {},
) {
  return async function guarded(request: NextRequest): Promise<NextResponse> {
    // The permission check does its own session lookup and maps 401/503, so
    // the only thing left to ask here is whether this caller may go on.
    const session = await requirePermission(request, permission);
    if (session instanceof NextResponse) return session;

    if (!options.skipRateLimit) {
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || request.headers.get('x-real-ip')
        || 'unknown';
      const allowed = await checkRateLimit(
        `${ip}:${request.nextUrl.pathname}`,
        true,
        options.rateLimit,
        true,
        session.userId,
        session.adminRole);
      if (!allowed) return jsonTooManyRequests();
    }

    return handler(request, session);
  };
}
