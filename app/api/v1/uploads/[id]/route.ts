import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { ok, apiError, getUploadSession, requireCdnAccess } from '@/features/media/cdnV1';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

// GET /v1/uploads/:id — byte progress of an upload session.
export async function GET(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const upload = getUploadSession(decodeURIComponent(id));
  if (!upload) return apiError('UPLOAD_NOT_FOUND', 'Unknown upload session.', 404);
  const denied = requireCdnAccess(session, 'uploads:create', `/${upload.destPath || upload.filename}`);
  if (denied) return denied;
  return ok({
    upload: {
      upload_id: upload.id,
      path: `/${upload.destPath || upload.filename}`,
      size: upload.size,
      received: upload.received,
      status: upload.status,
    },
  });
}
