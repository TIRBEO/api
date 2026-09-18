import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { canonicalizePath } from '@/features/media/cdnPath';
import {
  ok, created, paged, apiError, requireCdnAccess,
  listDtoChildren, uploadCdnFile, getActorProfile, getDtoByCanonicalPath,
  renameCdnFile, moveCdnFile,
} from '@/features/media/cdnV1';
import { getFolderByPath } from '@/features/media/cdnStorage';

export const runtime = 'nodejs';

// GET /v1/folders?path=/ — logical subfolders at a prefix (folders are path prefixes).
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  let prefix = '';
  try {
    prefix = canonicalizePath(request.nextUrl.searchParams.get('path') || '/').path.replace(/\/$/, '');
  } catch (e: any) {
    if (e?.code) return apiError('INVALID_PATH', e.message, 400);
    throw e;
  }
  const denied = requireCdnAccess(session, 'folders:read', `/${prefix}`);
  if (denied) return denied;
  try {
    const { folders } = await listDtoChildren(prefix);
    return paged(folders, null);
  } catch (err: any) {
    return apiError('LIST_FAILED', err?.message || 'Failed to list folders.', 500);
  }
}

// POST /v1/folders — { name, path? } creates `path/name/`.
export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  try {
    const body: any = await request.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.includes('/')) return apiError('INVALID_NAME', 'Valid folder `name` required.', 422);
    let dir = '';
    try {
      dir = canonicalizePath(body.path || '/').path.replace(/\/$/, '');
    } catch (e: any) {
      if (e?.code) return apiError('INVALID_PATH', e.message, 400);
      throw e;
    }
    const full = dir ? `${dir}/${name}` : name;
    const denied = requireCdnAccess(session, 'folders:write', `/${full}`);
    if (denied) return denied;
    const owner = await getActorProfile(session.userId).catch(() => ({ name: null, email: null }));
    const dto = await uploadCdnFile({
      userId: session.userId,
      filename: full,
      contentType: 'application/x-tirbeo-folder',
      bytes: Buffer.alloc(0),
      folder: true,
      owner: { id: session.userId, name: owner.name, email: owner.email },
    });
    return created({ folder: { name, path: full, id: dto.id } });
  } catch (err: any) {
    return apiError('CREATE_FAILED', err?.message || 'Failed to create folder.', 500);
  }
}

// PATCH /v1/folders — { path, name?, destination? } rename and/or move a folder.
// Renaming/moving the folder row re-parents the whole subtree atomically.
export async function PATCH(request: NextRequest) {
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
    const denied = requireCdnAccess(session, 'folders:write', `/${canonical}`);
    if (denied) return denied;
    const dto = await getDtoByCanonicalPath(canonical);
    if (!dto || !(dto as { folder?: boolean }).folder) {
      return apiError('FOLDER_NOT_FOUND', 'Managed folder not found at path.', 404);
    }
    if (typeof body.destination === 'string' && body.destination) {
      let dest: string;
      try {
        dest = canonicalizePath(body.destination).path.replace(/\/$/, '');
      } catch (e: any) {
        if (e?.code) return apiError('INVALID_PATH', e.message, 400);
        throw e;
      }
      const destDenied = requireCdnAccess(session, 'folders:write', `/${dest}`);
      if (destDenied) return destDenied;
      const destSegs = dest.split('/');
      const destName = destSegs[destSegs.length - 1];
      const destParent = destSegs.slice(0, -1);
      let parentId: string | null = null;
      if (destParent.length > 0) {
        const folder = await getFolderByPath(destParent);
        if (!folder) return apiError('INVALID_PATH', 'Destination parent does not exist.', 422);
        parentId = folder.id;
      }
      await moveCdnFile(session.userId, dto.id, parentId);
      const leaf = destName;
      const currentLeaf = canonical.split('/').pop();
      if (leaf !== currentLeaf) await renameCdnFile(session.userId, dto.id, leaf);
      return ok({ folder: { path: dest } });
    }
    if (typeof body.name === 'string' && body.name.trim() && !body.name.includes('/')) {
      await renameCdnFile(session.userId, dto.id, body.name.trim());
      const parent = canonical.split('/').slice(0, -1).join('/');
      return ok({ folder: { path: parent ? `${parent}/${body.name.trim()}` : body.name.trim() } });
    }
    return apiError('INVALID_NAME', 'Provide `name` and/or `destination`.', 422);
  } catch (err: any) {
    return apiError('UPDATE_FAILED', err?.message || 'Update failed.', 500);
  }
}

// DELETE /v1/folders — { path } removes an empty logical folder.
export async function DELETE(request: NextRequest) {
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
    const denied = requireCdnAccess(session, 'folders:delete', `/${canonical}`);
    if (denied) return denied;
    const { folders, files } = await listDtoChildren(canonical);
    const nested = folders.length > 0 || files.length > 0;
    if (nested) return apiError('FOLDER_NOT_EMPTY', 'Folder is not empty.', 409);
    return ok({ ok: true, removed: 0 });
  } catch (err: any) {
    return apiError('DELETE_FAILED', err?.message || 'Delete failed.', 500);
  }
}
