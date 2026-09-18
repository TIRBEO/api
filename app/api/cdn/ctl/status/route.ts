import { NextRequest, NextResponse } from 'next/server';
import { requireSession, getAdminRole, roleAtLeast } from '@/features/auth/http-guards';
import { cdnStatus } from '@/features/media/cdnControl';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/cdn/ctl/status — CDN control-plane snapshot (the "leader" view).
 *
 * Cluster status for the whole company CDN: instance identity, edge cache
 * occupancy, live WebSocket clients, storage limits, realtime transports.
 * Same session cookies as every other /api route — the CDN dashboard (and any
 * Tirbeo app) can poll or subscribe to it without extra credentials.
 *
 * Managers+ get the full snapshot; other members get a redacted view
 * (no cache internals) but the same realtime truth.
 *
 * Query: ?range=1|24 — rolling window (hours) the event counters cover.
 * Default 1h; 24h returns 24h-wide counts and a 24h-wide sparkline.
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  const rangeParam = request.nextUrl.searchParams.get('range');
  const rangeHours = rangeParam === '24' || rangeParam === '24h' ? 24 : 1;

  const role = (await getAdminRole(session.userId)) ?? 'member';
  const snapshot = await cdnStatus(rangeHours);

  if (!roleAtLeast(role, 'manager')) {
    return NextResponse.json({
      ...snapshot,
      cache: { entries: 0, bytes: 0, maxBytes: 0, hit: false, redacted: true },
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
}
