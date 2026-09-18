import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { canonicalizePath } from '@/features/media/cdnPath';
import {
  ok, created, apiError, v1FileFromDto, requireCdnAccess,
  getCdnFileMeta, getCdnFileBytes, uploadCdnFile, getActorProfile,
} from '@/features/media/cdnV1';
import { ensureFolderChain } from '@/features/media/cdnStorage';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

// POST /v1/files/:id/copy { destination }
export async function POST(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const fileId = decodeURIComponent(id);
  try {
    const body: any = await request.json().catch(() => ({}));
    if (typeof body.destination !== 'string') return apiError('INVALID_PATH', 'destination is required.', 422);
    const dto = await getCdnFileMeta(fileId);
    if ((dto as { folder?: boolean }).folder) return apiError('INVALID_OPERATION', 'Folders cannot be copied file-wise.', 422);
    const current = v1FileFromDto(dto);
    let denied = requireCdnAccess(session, 'files:read', `/${current.path}`);
    if (denied) return denied;
    const dest = canonicalizePath(body.destination);
    if (!dest.path) return apiError('INVALID_PATH', 'destination is required.', 422);
    denied = requireCdnAccess(session, 'files:write', `/${dest.path}`);
    if (denied) return denied;

    // Ensure parent folder chain exists (created on demand) for the copy target.
    const segs = dest.segments;
    const name = segs[segs.length - 1];
    const parentSegs = segs.slice(0, -1);
    const parentId = parentSegs.length ? await ensureFolderChain(session.userId, parentSegs) : null;
    const { bytes } = await getCdnFileBytes(fileId);
    const owner = await getActorProfile(session.userId).catch(() => ({ name: null, email: null }));
    const createdDto = await uploadCdnFile({
      userId: session.userId,
      filename: name,
      contentType: dto.contentType,
      bytes,
      parentId,
      visibility: dto.visibility === 'private' ? 'private' : 'public',
      owner: { id: session.userId, name: owner.name, email: owner.email },
    });
    return created({ file: v1FileFromDto(createdDto) });
  } catch (err: any) {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    return apiError('COPY_FAILED', err?.message || 'Copy failed.', status);
  }
}
