import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { requireSession } from '@/features/auth/http-guards';
import { isCockroachHealthy } from '@/infrastructure/db/cockroach';
import { getCdnFileBytes, markCdnFileOpened } from '@/features/media/cdnStorage';
import { buildContentDisposition } from '@/features/media/cdnContent';
import { getImageThumbnail, isImageMime } from '@/features/media/cdnThumb';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cdn/files/[id]/content?disposition=inline|attachment[&thumb=1]
 * Streams the file bytes out of CockroachDB. Inline is used by previews;
 * attachment triggers a browser download.
 *
 * `thumb=1` (grid thumbnails) takes the FAST lane: images are resized to a
 * small WebP derivative (sharp + in-memory LRU cache) instead of shipping
 * the full-size blob, skips the opened-marking DB write, and gets strong
 * ETags so revisits are free (304, zero bytes).
 *
 * EVERY response carries a strong ETag derived from (fileId, updatedAt,
 * variant) — a reload of a giant preview is a 304 with no body at all.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'File id is required' }, { status: 400 });

  try {
    // Company CDN: any member can read any org file; the open is actor-logged.
    const { dto, bytes } = await getCdnFileBytes(id);

    const url = new URL(request.url);
    const disposition = url.searchParams.get('disposition') === 'attachment' ? 'attachment' : 'inline';
    const isThumb = url.searchParams.get('thumb') === '1';

    // Strong ETag: content-addressed per file version + variant.
    const etag = `"${id}-${dto.updatedAt}${isThumb ? '-t' : ''}"`;
    if (request.headers.get('if-none-match') === etag) {
      // Mark opened + actor-logged even on 304s (fire and forget) — powers
      // "Recent" ordering without a body re-download.
      if (!isThumb) markCdnFileOpened(session.userId, id).catch(() => {});
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'private, max-age=86400, stale-while-revalidate=604800',
        },
      });
    }

    // Thumbnails skip the opened-marking write: previews shouldn't pollute
    // recent/activity AND thumbnail walls would otherwise fire dozens of DB
    // writes per page.
    if (!isThumb) {
      markCdnFileOpened(session.userId, id).catch(() => {});
    }

    const headers: Record<string, string> = {
      ETag: etag,
      'Content-Disposition': buildContentDisposition(dto.filename, disposition),
      'Cache-Control': 'private, max-age=86400, stale-while-revalidate=604800',
      'X-Content-Type-Options': 'nosniff',
    };

    // ── Thumbnail lane: real WebP derivatives for images ──
    if (isThumb && isImageMime(dto.contentType) && !dto.folder) {
      try {
        const thumb = await getImageThumbnail(id, String(dto.updatedAt), bytes);
        return new NextResponse(new Uint8Array(thumb.bytes), {
          status: 200,
          headers: {
            ...headers,
            'Content-Type': thumb.contentType,
            'Content-Length': String(thumb.bytes.length),
          },
        });
      } catch {
        // Corrupt/unsupported image — fall through and serve the original.
      }
    }

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...headers,
        'Content-Type': dto.contentType || 'application/octet-stream',
        'Content-Length': String(bytes.length),
      },
    });
  } catch (err: any) {
    const status = err?.statusCode || 500;
    if (status >= 500) console.error('[CDN] Content fetch failed:', err?.message);
    return NextResponse.json({ error: err?.message || 'Failed to read file' }, { status });
  }
}
