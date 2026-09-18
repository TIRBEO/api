import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { isCockroachHealthy } from '@/infrastructure/db/cockroach';
import { listCdnActivity } from '@/features/media/cdnStorage';

export const runtime = 'nodejs';

/**
 * GET /api/cdn/activity?limit=100 — company-wide CDN audit feed.
 * Every cdn.* event logged to Supabase (upload, open, rename, star, trash,
 * restore, delete, denied deletes, share links), with actor names resolved.
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  try {
    const limitParam = Number(request.nextUrl.searchParams.get('limit') || '100');
    const limit = Number.isFinite(limitParam) ? limitParam : 100;
    const events = await listCdnActivity(limit);
    return NextResponse.json(
      { events, scope: 'company' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err: any) {
    console.error('[CDN-ACTIVITY] List failed:', err?.message);
    return NextResponse.json({ error: 'Failed to load activity' }, { status: 500 });
  }
}
