import { NextRequest, NextResponse } from 'next/server';
import { getFileByPublicPath, getCanonicalPublicPath, getPrewarmedBytesByPublicPath } from '@/features/media/cdnStorage';
import { isCockroachHealthy } from '@/infrastructure/db/cockroach';
import { buildContentDisposition } from '@/features/media/cdnContent';
import { verifyCdnSignature } from '@/features/media/cdnSigned';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cdn/u/[...path] — public, permanent file URL.
 * Path = "a/<folder1>/.../<folderN>/<filename.ext>".
 *
 * PUBLIC files: no auth — meant to be embedded anywhere (img src, CSS
 * backgrounds, etc). PRIVATE files: only fetchable with a valid signed URL
 * (`?expires=&sig=`) minted via POST /v1/signed-urls.
 *
 * Optional ?download=1 forces a download instead of inline rendering.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  const { path: segments } = await params;
  if (!segments || segments.length < 2) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    // ── Control-plane fast lane: when the leader pre-warmed this path's bytes
    // into memory (profile pics, media, share downloads), serve them with a
    // metadata-only lookup — no blob query at all. Falls through to the
    // regular resolve+cache path on any miss. ──
    const warmed = await getPrewarmedBytesByPublicPath(segments);
    const result = warmed ?? (await getFileByPublicPath(segments));
    if (!result) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const search = request.nextUrl.searchParams;
    const forceDownload = search.get('download') === '1';
    const signedFilename = search.get('filename');

    // Private files require a valid, unexpired signature. Every check is
    // constant-time; a bad/missing/expired sig is treated the same (403) so
    // we don't leak which condition failed.
    const isPrivate = result.visibility === 'private';
    if (isPrivate && !verifyCdnSignature(result.fileId, search.get('expires'), search.get('sig'))) {
      return NextResponse.json(
        { error: 'Access denied. This is a private file — generate a signed URL to view it.' },
        {
          status: 403,
          headers: {
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        },
      );
    }

    // Public: strong ETag + long cache. Private (signed): short-cache only.
    const cacheControl = isPrivate
      ? 'private, max-age=60, must-revalidate'
      : 'public, max-age=86400, stale-while-revalidate=604800';
    const etag = `"u-${result.fileId}-${result.bytes.length}"`;
    if (request.headers.get('if-none-match') === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': cacheControl,
          ...(isPrivate ? { 'Cache-Control': 'private, max-age=60, must-revalidate' } : {}),
        },
      });
    }

    // Self-healing links: when the request came through an old/aliased path
    // (folder renamed/moved since the link was copied), advertise the file's
    // CURRENT canonical /u/a/... URL in a Link header. Browsers and CDN
    // caches learn the canonical location; hotlinking apps keep working.
    let linkHeader: string | undefined;
    const origin = new URL(request.url).origin;
    try {
      const canonical = await getCanonicalPublicPath(result.fileId);
      if (canonical) {
        const requested = '/' + (segments ?? []).map((s) => encodeURIComponent(s)).join('/');
        if (canonical !== requested) {
          linkHeader = `<${origin}${canonical}>; rel="canonical"`;
        }
      }
    } catch {
      // header is best-effort
    }

    const filename = signedFilename || result.filename.split('/').pop() || 'file';
    const headers: Record<string, string> = {
      ETag: etag,
      'Content-Type': result.mimeType || 'application/octet-stream',
      'Content-Length': String(result.bytes.length),
      'Content-Disposition': buildContentDisposition(filename, forceDownload ? 'attachment' : 'inline'),
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    };
    if (linkHeader) headers.Link = linkHeader;

    return new NextResponse(new Uint8Array(result.bytes), { status: 200, headers });
  } catch (err: any) {
    console.error('[CDN-U] Fetch failed:', err?.message);
    return NextResponse.json({ error: 'Unable to load file' }, { status: 500 });
  }
}