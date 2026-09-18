import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { canonicalizePath } from '@/features/media/cdnPath';
import {
  ok, created, apiError, v1FileFromDto, requireCdnAccess,
  getDtoByCanonicalPath, listDtoChildren, uploadCdnFile, getActorProfile,
  moveToTrash, MAX_UPLOAD_BYTES,
} from '@/features/media/cdnV1';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Ctx = { params: Promise<{ rest: string[] }> };

function canonicalFromSegments(segs: string[]): string {
  const joined = '/' + segs.map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  }).join('/');
  return canonicalizePath(joined).path.replace(/\/$/, '');
}

// GET /v1/path/* — file metadata or folder listing at a canonical path.
export async function GET(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const { rest } = await ctx.params;
  let canonical: string;
  try {
    canonical = canonicalFromSegments(rest);
  } catch (e: any) {
    if (e?.code) return apiError('INVALID_PATH', e.message, 400);
    throw e;
  }
  const denied = requireCdnAccess(session, 'files:read', `/${canonical}`);
  if (denied) return denied;
  try {
    const dto = await getDtoByCanonicalPath(canonical);
    if (dto) {
      return ok({ file: v1FileFromDto(dto) });
    }
    const { folders, files } = await listDtoChildren(canonical);
    return ok({ path: canonical, folders, files });
  } catch (err: any) {
    return apiError('PATH_FAILED', err?.message || 'Lookup failed.', 500);
  }
}

// POST /v1/path/* — write raw request bytes to the exact path (creates/overwrites).
export async function POST(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const { rest } = await ctx.params;
  let canonical: string;
  try {
    canonical = canonicalFromSegments(rest);
  } catch (e: any) {
    if (e?.code) return apiError('INVALID_PATH', e.message, 400);
    throw e;
  }
  if (!canonical) return apiError('INVALID_PATH', 'File path required.', 422);
  const denied = requireCdnAccess(session, 'files:write', `/${canonical}`);
  if (denied) return denied;
  try {
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length === 0) return apiError('EMPTY_FILE', 'Empty body.', 400);
    if (bytes.length > MAX_UPLOAD_BYTES) return apiError('FILE_TOO_LARGE', `Body exceeds ${MAX_UPLOAD_BYTES} bytes.`, 413);
    const contentType = request.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream';
    const owner = await getActorProfile(session.userId).catch(() => ({ name: null, email: null }));
    const dto = await uploadCdnFile({
      userId: session.userId,
      filename: canonical,
      contentType,
      bytes,
      owner: { id: session.userId, name: owner.name, email: owner.email },
    });
    return created({ file: v1FileFromDto(dto) });
  } catch (err: any) {
    return apiError('WRITE_FAILED', err?.message || 'Write failed.', 500);
  }
}

// DELETE /v1/path/* — move the object at path to trash.
export async function DELETE(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const { rest } = await ctx.params;
  let canonical: string;
  try {
    canonical = canonicalFromSegments(rest);
  } catch (e: any) {
    if (e?.code) return apiError('INVALID_PATH', e.message, 400);
    throw e;
  }
  const denied = requireCdnAccess(session, 'files:delete', `/${canonical}`);
  if (denied) return denied;
  try {
    const dto = await getDtoByCanonicalPath(canonical);
    if (!dto) return apiError('FILE_NOT_FOUND', 'The requested file does not exist.', 404);
    await moveToTrash(session.userId, dto.id);
    return ok({ ok: true });
  } catch (err: any) {
    return apiError('DELETE_FAILED', err?.message || 'Delete failed.', 500);
  }
}
