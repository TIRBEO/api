import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { isCockroachHealthy } from '@/infrastructure/db/cockroach';
import { purgeExpiredTrash, purgeAllExpiredTrash, selfDestructSweep } from '@/features/media/cdnStorage';

export const runtime = 'nodejs';
export const maxDuration = 60;

function isAuthorizedCron(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

/**
 * Company CDN trash purge.
 * POST /api/cdn/purge-trash — authed: purge expired trash (org-wide).
 * GET  /api/cdn/purge-trash — cron only: purge expired trash + self-destruct sweep.
 */
export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  try {
    const deletedCount = await purgeExpiredTrash();
    return NextResponse.json({ success: true, deletedCount });
  } catch (err: any) {
    console.error('[CDN-PURGE] User purge failed:', err?.message);
    return NextResponse.json({ error: 'Failed to purge trash' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const deletedCount = await purgeAllExpiredTrash();
    const selfDestructed = await selfDestructSweep();
    return NextResponse.json({ success: true, deletedCount, selfDestructed });
  } catch (err: any) {
    console.error('[CDN-PURGE] Global purge failed:', err?.message);
    return NextResponse.json({ error: 'Failed to purge trash' }, { status: 500 });
  }
}
