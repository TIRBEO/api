import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { ok, requireCdnAccess } from '@/features/media/cdnV1';

export const runtime = 'nodejs';

// GET /v1/usage/requests — request counts (event pipeline aggregates here).
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const denied = requireCdnAccess(session, 'usage:read');
  if (denied) return denied;
  return ok({ requests: { used: 0, limit: 20_000_000, cache_hit_rate: null } });
}
