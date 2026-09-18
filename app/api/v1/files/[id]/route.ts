import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import {
  ok, apiError, v1FileFromDto, requireCdnAccess,
  getCdnFileMeta, renameCdnFile, moveToTrash, restoreFromTrash, permanentlyDeleteCdnFile, setCdnFileVisibility,
} from '@/features/media/cdnV1';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

// GET /v1/files/:id
export async function GET(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  try {
    const dto = await getCdnFileMeta(decodeURIComponent(id));
    const file = v1FileFromDto(dto);
    const denied = requireCdnAccess(session, 'files:read', `/${file.path}`);
    if (denied) return denied;
    return ok({ file });
  } catch (err: any) {
    return apiError('FILE_NOT_FOUND', 'The requested file does not exist.', 404);
  }
}

// PATCH /v1/files/:id — { name?, visibility?, trashed? }
export async function PATCH(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const fileId = decodeURIComponent(id);
  try {
    const dto = await getCdnFileMeta(fileId);
    const current = v1FileFromDto(dto);
    const denied = requireCdnAccess(session, 'files:write', `/${current.path}`);
    if (denied) return denied;
    const body: any = await request.json().catch(() => ({}));
    if (typeof body.name === 'string' && body.name.trim() && !body.name.includes('/')) {
      await renameCdnFile(session.userId, fileId, body.name.trim());
    }
    if (body.visibility === 'public' || body.visibility === 'private') {
      await setCdnFileVisibility(session.userId, fileId, body.visibility);
    }
    if (body.trashed === true) await moveToTrash(session.userId, fileId);
    if (body.trashed === false) await restoreFromTrash(session.userId, fileId);
    const updated = v1FileFromDto(await getCdnFileMeta(fileId));
    return ok({ file: updated });
  } catch (err: any) {
    return apiError('UPDATE_FAILED', err?.message || 'Update failed.', 500);
  }
}

// DELETE /v1/files/:id — permanent delete (manager+ enforced downstream)
export async function DELETE(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const fileId = decodeURIComponent(id);
  try {
    const dto = await getCdnFileMeta(fileId);
    const denied = requireCdnAccess(session, 'files:delete', `/${v1FileFromDto(dto).path}`);
    if (denied) return denied;
    await permanentlyDeleteCdnFile(session.userId, fileId);
    return ok({ ok: true });
  } catch (err: any) {
    const status = /only managers/i.test(err?.message || '') ? 403 : 500;
    return apiError(status === 403 ? 'FORBIDDEN' : 'DELETE_FAILED', err?.message || 'Delete failed.', status);
  }
}
