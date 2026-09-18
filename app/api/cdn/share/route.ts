import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { isCockroachHealthy } from '@/infrastructure/db/cockroach';
import { createShareLink } from '@/features/media/cdnStorage';

export const runtime = 'nodejs';

/**
 * POST /api/cdn/share — create a one-time share link for a company file.
 * Body: { fileId, expiresInMinutes? } — optional TTL (1 min – 30 days);
 * omitted = the link never expires (but is still single-use).
 */
export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body?.fileId) {
    return NextResponse.json({ error: 'fileId is required' }, { status: 400 });
  }

  try {
    const origin =
      request.headers.get('origin') ||
      process.env.NEXT_PUBLIC_CDN_URL ||
      new URL(request.url).origin;

    // Optional TTL: minutes (number) or an absolute epoch-ms expiresAt.
    let expiresAt: number | null = null;
    if (typeof body.expiresInMinutes === 'number' && body.expiresInMinutes > 0) {
      expiresAt = Date.now() + body.expiresInMinutes * 60_000;
    } else if (typeof body.expiresAt === 'number' && body.expiresAt > Date.now()) {
      expiresAt = body.expiresAt;
    }

    const result = await createShareLink({
      userId: session.userId,
      fileId: body.fileId,
      origin,
      expiresAt,
    });
    return NextResponse.json(result);
  } catch (err: any) {
    const status = err?.statusCode || 500;
    console.error('[CDN-SHARE] Create link failed:', err?.message);
    return NextResponse.json({ error: err?.message || 'Failed to create share link' }, { status });
  }
}
