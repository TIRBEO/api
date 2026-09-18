import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import {
  ok, created, apiError, v1FileFromDto, requireCdnAccess,
  getUploadSession, uploadCdnFile, getActorProfile,
} from '@/features/media/cdnV1';
import { ensureFolderChain } from '@/features/media/cdnStorage';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

// POST /v1/uploads/:id/complete — verify + publish the object.
// For direct-to-storage flows the client sends { checksum? }; for proxied
// flows the client may send raw bytes as the body instead.
export async function POST(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const upload = getUploadSession(decodeURIComponent(id));
  if (!upload) return apiError('UPLOAD_NOT_FOUND', 'Unknown upload session.', 404);

  const dest = upload.destPath || upload.filename;
  const denied = requireCdnAccess(session, 'files:write', `/${dest}`);
  if (denied) return denied;

  try {
    const contentType = request.headers.get('content-type') || '';
    // Proxied completion: raw bytes in the body become the object.
    if (contentType && !contentType.includes('application/json')) {
      const bytes = Buffer.from(await request.arrayBuffer());
      if (bytes.length === 0) return apiError('EMPTY_FILE', 'Empty body.', 400);
      // Resolve the destination's folder chain to real folder rows.
      const segs = dest.split('/');
      const name = segs.pop() || upload.filename;
      const parentId = segs.length ? await ensureFolderChain(session.userId, segs) : null;
      const owner = await getActorProfile(session.userId).catch(() => ({ name: null, email: null }));
      const dto = await uploadCdnFile({
        userId: session.userId,
        filename: name,
        contentType: contentType.split(';')[0].trim() || upload.mimeType,
        bytes,
        parentId,
        owner: { id: session.userId, name: owner.name, email: owner.email },
        visibility: upload.visibility,
      });
      return created({ id: dto.id, path: `/${dest}`, status: 'ready', file: v1FileFromDto(dto) });
    }
    // Direct-to-storage completion: verification happens against the object
    // store; metadata-only acknowledgement here.
    return ok({ id: upload.id, path: `/${dest}`, status: 'ready' });
  } catch (err: any) {
    return apiError('COMPLETE_FAILED', err?.message || 'Complete failed.', 500);
  }
}

// DELETE /v1/uploads/:id — cancel an upload session.
export async function DELETE(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const upload = getUploadSession(decodeURIComponent(id));
  if (!upload) return apiError('UPLOAD_NOT_FOUND', 'Unknown upload session.', 404);
  upload.status = 'cancelled';
  return ok({ ok: true });
}
