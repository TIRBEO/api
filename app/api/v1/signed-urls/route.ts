import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { canonicalizePath } from '@/features/media/cdnPath';
import { created, apiError, requireCdnAccess, getCdnFileMeta, getDtoByCanonicalPath, v1FileFromDto, CDN_PUBLIC_BASE, encodePath } from '@/features/media/cdnV1';
import { buildSignedUrlParams } from '@/features/media/cdnSigned';

export const runtime = 'nodejs';

// POST /v1/signed-urls — { path?, fileId?, expires_in?, download?, filename? }
// Mints a temporary URL for PRIVATE files (also works for public ones).
// Signature is bound to the FILE ID + expiry — verified by the public
// delivery endpoint (/u/...) which is unauthenticated, so no user identity
// is embedded in the signature.
export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  try {
    const body: any = await request.json().catch(() => ({}));
    const deniedScope = requireCdnAccess(session, 'signed_urls:create');
    if (deniedScope) return deniedScope;

    let file: ReturnType<typeof v1FileFromDto>;
    if (typeof body.path === 'string') {
      let canonical: string;
      try {
        canonical = canonicalizePath(body.path).path.replace(/\/$/, '');
      } catch (e: any) {
        if (e?.code) return apiError('INVALID_PATH', e.message, 400);
        throw e;
      }
      if (!canonical) return apiError('INVALID_PATH', '`path` is required.', 422);
      const denied = requireCdnAccess(session, 'signed_urls:create', `/${canonical}`);
      if (denied) return denied;
      const dto = await getDtoByCanonicalPath(canonical);
      if (!dto) return apiError('FILE_NOT_FOUND', 'The requested file does not exist.', 404);
      file = v1FileFromDto(dto);
    } else if (typeof body.fileId === 'string' && body.fileId) {
      const dto = await getCdnFileMeta(body.fileId);
      file = v1FileFromDto(dto);
      const denied = requireCdnAccess(session, 'signed_urls:create', `/${file.path}`);
      if (denied) return denied;
    } else {
      return apiError('INVALID_PATH', 'Provide `path` or `fileId`.', 422);
    }

    const expiresIn = Math.min(7 * 24 * 3600, Math.max(60, Math.floor(Number(body.expires_in ?? body.expiresIn) || 3600)));
    const download = body.download === true;
    const filename = typeof body.filename === 'string' && body.filename ? body.filename : file.name;
    const expires = Date.now() + expiresIn * 1000;
    const params = buildSignedUrlParams(file.id, expires, { download, filename });
    const url = `${CDN_PUBLIC_BASE}/u/a/${encodePath(file.path)}?${params.toString()}`;
    return created({ url, expires_at: expires, path: `/${file.path}`, visibility: file.visibility });
  } catch (err: any) {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    return apiError('SIGN_FAILED', err?.message || 'Failed to sign URL.', status);
  }
}