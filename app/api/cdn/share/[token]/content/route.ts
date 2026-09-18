import { NextRequest, NextResponse } from 'next/server';
import { getShareContentBytes, getShareLinkRecord } from '@/features/media/cdnStorage';
import { isCockroachHealthy } from '@/infrastructure/db/cockroach';
import { buildContentDisposition } from '@/features/media/cdnContent';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cdn/share/[token]/content — public content stream for a
 * *already-redeemed* one-time link. Only the redeem flow hands this URL out,
 * and the link is single-use, so this endpoint is unreachable until the
 * atomic redeem flips the flag.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  const { token } = await params;
  try {
    const result = await getShareContentBytes(token);
    if (!result) {
      return NextResponse.json(
        { error: 'This share link has not been opened yet or is invalid' },
        { status: 403 },
      );
    }

    // Cache window: redeemed content is immutable, BUT a link with a TTL
    // should stop being cacheable once it expires. Cache until expiry,
    // capped at 1 hour (never shared-cacheable — token URLs are private).
    const record = await getShareLinkRecord(token);
    let maxAge = 3600;
    if (record?.expiresAt) {
      maxAge = Math.max(0, Math.min(3600, Math.floor((record.expiresAt - Date.now()) / 1000)));
    }
    const cacheControl =
      maxAge > 0
        ? `private, max-age=${maxAge}, stale-while-revalidate=${maxAge * 2}`
        : 'private, no-store';

    return new NextResponse(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        'Content-Type': result.mimeType || 'application/octet-stream',
        'Content-Length': String(result.bytes.length),
        // Use the real stored filename — not the MIME type — for downloads.
        'Content-Disposition': buildContentDisposition(result.filename || 'download', request.nextUrl.searchParams.get('download') === '1' ? 'attachment' : 'inline'),
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err: any) {
    console.error('[CDN-SHARE] Content fetch failed:', err?.message);
    return NextResponse.json({ error: 'Unable to load shared file' }, { status: 500 });
  }
}
