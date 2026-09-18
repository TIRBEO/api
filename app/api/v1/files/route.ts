import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { canonicalizePath, PathError } from '@/features/media/cdnPath';
import {
  created, paged, apiError, parseLimit,
  v1FileFromDto, requireCdnAccess,
  listAllCdnFiles, uploadCdnFile, getActorProfile, MAX_UPLOAD_BYTES,
} from '@/features/media/cdnV1';
import { ensureFolderChain } from '@/features/media/cdnStorage';

export const runtime = 'nodejs';
export const maxDuration = 60;

// GET /v1/files?path=&recursive=&limit=&cursor=
// Lists files under a canonical path prefix. Sizes are integer bytes.
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;

  const q = request.nextUrl.searchParams;
  let prefix = '';
  try {
    const raw = q.get('path') || '/';
    prefix = canonicalizePath(raw).path.replace(/\/$/, '');
  } catch (e: any) {
    if (e?.code) return apiError('INVALID_PATH', e.message, 400);
    throw e;
  }
  const denied = requireCdnAccess(session, 'files:read', prefix ? `/${prefix}` : '/');
  if (denied) return denied;

  const recursive = (q.get('recursive') || 'false').toLowerCase() === 'true';
  const limit = parseLimit(q);
  const cursor = q.get('cursor') || null;

  try {
    const { active } = await listAllCdnFiles();
    let files = active.filter((f) => !f.folder).map((f) => v1FileFromDto(f));
    if (prefix) {
      files = files.filter((f) => f.path === prefix || f.path.startsWith(`${prefix}/`));
      if (!recursive) {
        files = files.filter((f) => {
          const rest = f.path === prefix ? '' : f.path.slice(prefix.length + 1);
          return rest !== '' && !rest.includes('/');
        });
      }
    }
    files.sort((a, b) => b.updatedAt - a.updatedAt);
    let start = 0;
    if (cursor) {
      const idx = files.findIndex((f) => f.id === cursor);
      if (idx >= 0) start = idx + 1;
    }
    const page = files.slice(start, start + limit);
    const next = start + limit < files.length ? files[start + limit - 1].id : null;
    return paged(page, next);
  } catch (err: any) {
    return apiError('LIST_FAILED', err?.message || 'Failed to list files.', 500);
  }
}

// POST /v1/files (multipart: file, path?, filename?)
// `path` is the destination folder (`/avatars/users/usr_123/`); the stored
// object becomes `{path}/{filename}`. Sizes recorded as integer bytes.
export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;

  try {
    const form = await request.formData();
    const upload = form.get('file');
    if (!(upload instanceof Blob)) return apiError('FILE_REQUIRED', 'Multipart field `file` is required.', 400);

    let dir = '';
    try {
      const rawDir = (form.get('path') as string) || '/';
      dir = canonicalizePath(rawDir).path.replace(/\/$/, '');
    } catch (e: any) {
      if (e?.code) return apiError('INVALID_PATH', e.message, 400);
      throw e;
    }

    const denied = requireCdnAccess(session, 'files:write', dir ? `/${dir}` : '/');
    if (denied) return denied;

    const filename = ((form.get('filename') as string) || (upload as File).name || 'file').trim();
    if (!filename || filename.includes('/') || filename === '.' || filename === '..') {
      return apiError('INVALID_NAME', 'Invalid filename.', 400);
    }

    const rawVis = (form.get('visibility') as string) || '';
    const visibility = rawVis === 'private' ? 'private' : 'public';

    const bytes = Buffer.from(await upload.arrayBuffer());
    if (bytes.length === 0) return apiError('EMPTY_FILE', 'File is empty.', 400);
    if (bytes.length > MAX_UPLOAD_BYTES) {
      return apiError('FILE_TOO_LARGE', `File exceeds ${MAX_UPLOAD_BYTES} bytes.`, 413);
    }

    // `path` names the destination FOLDER — resolve it to a real folder row
    // (creating the chain when missing) so the file nests properly and its
    // public /u/a/<path>/<filename> URL works.
    const parentSegs = dir ? dir.split('/') : [];
    const parentId = parentSegs.length ? await ensureFolderChain(session.userId, parentSegs) : null;
    const owner = await getActorProfile(session.userId).catch(() => ({ name: null, email: null }));
    const dto = await uploadCdnFile({
      userId: session.userId,
      filename,
      contentType: (upload as File).type || 'application/octet-stream',
      bytes,
      parentId,
      owner: { id: session.userId, name: owner.name, email: owner.email },
      visibility,
    });
    return created({ file: v1FileFromDto(dto) });
  } catch (err: any) {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    return apiError(status === 413 ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED', err?.message || 'Upload failed.', status);
  }
}
