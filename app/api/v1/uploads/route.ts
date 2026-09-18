import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { canonicalizePath } from '@/features/media/cdnPath';
import {
  created, apiError, requireCdnAccess, createUploadSession, toBytes, MAX_UPLOAD_BYTES,
} from '@/features/media/cdnV1';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';

// POST /v1/uploads — { path, content_type, size } → direct-upload session.
// `path` is the full destination path (`avatars/x.webp`).
export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  try {
    const body: any = await request.json().catch(() => ({}));
    const rawPath = typeof body.path === 'string' ? body.path : null;
    const legacyName = typeof body.filename === 'string' ? body.filename : '';

    let canonical: string;
    if (rawPath) {
      try {
        canonical = canonicalizePath(rawPath).path.replace(/\/$/, '');
      } catch (e: any) {
        if (e?.code) return apiError('INVALID_PATH', e.message, 400);
        throw e;
      }
      if (!canonical) return apiError('INVALID_PATH', 'Upload path required.', 422);
    } else {
      if (!legacyName) return apiError('INVALID_PATH', '`path` is required.', 422);
      canonical = legacyName;
    }

    const denied = requireCdnAccess(session, 'uploads:create', `/${canonical}`);
    if (denied) return denied;

    const size = toBytes(body.size);
    if (size <= 0) return apiError('INVALID_SIZE', '`size` (bytes) is required.', 422);
    if (size > MAX_UPLOAD_BYTES) return apiError('FILE_TOO_LARGE', `Size exceeds ${MAX_UPLOAD_BYTES} bytes.`, 413);

    const contentType =
      (typeof body.content_type === 'string' && body.content_type) ||
      (typeof body.mimeType === 'string' && body.mimeType) ||
      'application/octet-stream';

    const upload = createUploadSession({
      id: `upl_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      filename: canonical.split('/').pop() || canonical,
      size,
      mimeType: contentType,
      destPath: canonical,
      visibility: body.visibility === 'private' ? 'private' : 'public',
    });
    return created({
      upload_id: upload.id,
      path: `/${canonical}`,
      method: 'PUT',
      upload_url: `/api/v1/uploads/${upload.id}/parts`,
      visibility: upload.visibility,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
  } catch (err: any) {
    return apiError('UPLOAD_CREATE_FAILED', err?.message || 'Failed to create upload.', 500);
  }
}
