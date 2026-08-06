import type { Route } from '@prisma/client';

// The Route model stores `internal`/`allowedRoles` inside the Json `metadata`
// column and the destination in `handler`, but the catch-all router reads them
// as top-level fields (`route.internal`, `route.allowedRoles`, `route.target`).
// This helper unpacks them so DB rows behave exactly like the router's
// hardcoded fallback route objects.
export interface NormalizedRoute extends Route {
  internal: boolean;
  allowedRoles: string[];
  target: string | null;
}

// Matches the seed + legacy admin Routes default; the router's role check is
// route.allowedRoles.includes(userRole), so a 'guest' default would block all
// authenticated members on external (non-internal) routes.
const DEFAULT_ALLOWED_ROLES = ['member'] as const;

export function normalizeRoute(route: Route): NormalizedRoute {
  const meta = (route.metadata ?? {}) as Record<string, unknown>;
  const rawAllowed = meta.allowedRoles;
  return {
    ...route,
    internal: meta.internal === true,
    allowedRoles: Array.isArray(rawAllowed) ? (rawAllowed as string[]) : [...DEFAULT_ALLOWED_ROLES],
    target: route.handler || null,
  };
}
