import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { canonicalizePath } from '@/features/media/cdnPath';
import {
  ok, apiError, v1FileFromDto, requireCdnAccess,
  getCdnFileMeta, getCdnFileBytes, renameCdnFile, moveCdnFile, uploadCdnFile, getActorProfile,
} from '@/features/media/cdnV1';
import { ensureFolderChain } from '@/features/media/cdnStorage';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

async function resolveDestination(dest: string, userId: string) {
  const c = canonicalizePath(dest);
  if (!c.path) throw Object.assign(new Error('Destination path required.'), { statusCode: 422 });
  const segs = c.segments;
  const name = segs[segs.length - 1];
  const parentSegs = segs.slice(0, -1);
  // Create the destination folder chain on demand (path-addressed moves).
  const parentId = parentSegs.length ? await ensureFolderChain(userId, parentSegs) : null;
  return { name, parentId, canonical: c.path };
}

// POST /v1/files/:id/move { destination }
export async function POST(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const fileId = decodeURIComponent(id);
  try {
    const body: any = await request.json().catch(() => ({}));
    if (typeof body.destination !== 'string') return apiError('INVALID_PATH', 'destination is required.', 422);
    const dto = await getCdnFileMeta(fileId);
    const current = v1FileFromDto(dto);
    let denied = requireCdnAccess(session, 'files:write', `/${current.path}`);
    if (denied) return denied;
    const dest = await resolveDestination(body.destination, session.userId);
    denied = requireCdnAccess(session, 'files:write', `/${dest.canonical}`);
    if (denied) return denied;
    await moveCdnFile(session.userId, fileId, dest.parentId);
    if (dest.name !== current.name) await renameCdnFile(session.userId, fileId, dest.name);
    return ok({ file: v1FileFromDto(await getCdnFileMeta(fileId)) });
  } catch (err: any) {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    return apiError(status === 422 ? 'INVALID_PATH' : 'MOVE_FAILED', err?.message || 'Move failed.', status);
  }
}
