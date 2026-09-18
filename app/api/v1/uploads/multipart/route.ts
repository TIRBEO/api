import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { canonicalizePath } from '@/features/media/cdnPath';
import { created, apiError, requireCdnAccess, createUploadSession, toBytes, MAX_UPLOAD_BYTES } from '@/features/media/cdnV1';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';

// POST /v1/uploads/multipart — { path, content_type, size, part_size? }
export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  try {
    const body: any = await request.json().catch(() => ({}));
    if (typeof body.path !== 'string') return apiError('INVALID_PATH', '`path` is required.', 422);
    let canonical: string;
    try {
      canonical = canonicalizePath(body.path).path.replace(/\/$/, '');
    } catch (e: any) {
      if (e?.code) return apiError('INVALID_PATH', e.message, 400);
      throw e;
    }
    if (!canonical) return apiError('INVALID_PATH', '`path` is required.', 422);
    const denied = requireCdnAccess(session, 'uploads:create', `/${canonical}`);
    if (denied) return denied;
    const size = toBytes(body.size);
    if (size <= 0) return apiError('INVALID_SIZE', '`size` (bytes) is required.', 422);
    if (size > MAX_UPLOAD_BYTES) return apiError('FILE_TOO_LARGE', `Size exceeds ${MAX_UPLOAD_BYTES} bytes.`, 413);
    const partSize = Math.min(size, Math.max(5 * 1024 * 1024, toBytes(body.part_size) || 5 * 1024 * 1024));
    const parts = Math.max(1, Math.ceil(size / partSize));
    const upload = createUploadSession({
      id: `upl_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      filename: canonical.split('/').pop() || canonical,
      size,
      mimeType: typeof body.content_type === 'string' ? body.content_type : 'application/octet-stream',
      destPath: canonical,
    });
    return created({
      upload_id: upload.id,
      path: `/${canonical}`,
      part_size: partSize,
      parts,
      status: 'created',
    });
  } catch (err: any) {
    return apiError('UPLOAD_CREATE_FAILED', err?.message || 'Failed to create upload.', 500);
  }
}
