import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { ok, apiError, requireCdnAccess, getUploadSession, markUploadProgress, toBytes } from '@/features/media/cdnV1';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

// POST /v1/uploads/:id/parts — report a received part { part_number, size }.
export async function POST(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const upload = getUploadSession(decodeURIComponent(id));
  if (!upload) return apiError('UPLOAD_NOT_FOUND', 'Unknown upload session.', 404);
  const denied = requireCdnAccess(session, 'uploads:create', `/${upload.destPath || upload.filename}`);
  if (denied) return denied;
  try {
    const body: any = await request.json().catch(() => ({}));
    const received = toBytes(body.received ?? body.size ?? 0);
    if (received > 0) markUploadProgress(upload.id, Math.min(upload.size, upload.received + received));
    const cur = getUploadSession(upload.id)!;
    return ok({ upload_id: cur.id, received: cur.received, size: cur.size, status: cur.status });
  } catch (err: any) {
    return apiError('PART_FAILED', err?.message || 'Part failed.', 500);
  }
}
