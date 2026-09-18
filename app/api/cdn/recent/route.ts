import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { isCockroachHealthy } from '@/infrastructure/db/cockroach';
import { listMyRecentFiles, listOrgRecentFiles } from '@/features/media/cdnStorage';

export const runtime = 'nodejs';

/**
 * GET /api/cdn/recent?scope=me|org&limit=N
 *
 * scope=me  — THIS user's recently-opened files (sidebar "Recent").
 * scope=org — the whole organization's latest opens/uploads/creations,
 *             time-ordered, with actor attribution (Home "Suggested").
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  const url = new URL(request.url);
  const scope = url.searchParams.get('scope') === 'org' ? 'org' : 'me';
  const limit = Number(url.searchParams.get('limit') || (scope === 'org' ? 60 : 40));

  try {
    const raw =
      scope === 'org'
        ? await listOrgRecentFiles(session.userId, limit)
        : await listMyRecentFiles(session.userId, limit);
    // Client contract: { file, actorId, actorName, openedAt, reason }.
    const entries = raw.map((e) => ({
      file: e.file,
      actorId: e.openedBy,
      actorName: (e as any).openedByName ?? null,
      openedAt: e.openedAt,
      reason: e.reason,
    }));
    return NextResponse.json(
      { entries, scope },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err: any) {
    console.error('[CDN-RECENT] Failed:', err?.message);
    return NextResponse.json({ error: 'Failed to load recents' }, { status: 500 });
  }
}
