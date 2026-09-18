import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { isCockroachHealthy } from '@/infrastructure/db/cockroach';
import {
  listAllCdnFiles,
  attachSelfDestruct,
  uploadCdnFile,
  getOrgStorageUsageBytes,
  getActorProfile,
  getFolderByPath,
  MAX_UPLOAD_BYTES,
} from '@/features/media/cdnStorage';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cdn/files
 * Company-wide CDN: returns ALL organization files (active + trash), visible
 * to every privileged member. Storage is the org-wide shared pool —
 * UNLIMITED (`limit: null`, the UI shows no cap).
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  try {
    const { active, trash } = await listAllCdnFiles();
    const usage = await getOrgStorageUsageBytes();
    const [withSdActive, withSdTrash] = await Promise.all([
      attachSelfDestruct(active),
      attachSelfDestruct(trash),
    ]);
    return NextResponse.json(
      {
        files: withSdActive,
        trash: withSdTrash,
        storage: { used: usage, limit: null, unlimited: true },
        maxUploadBytes: MAX_UPLOAD_BYTES,
        scope: 'company',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err: any) {
    console.error('[CDN] List files failed:', err?.message);
    return NextResponse.json({ error: 'Failed to list files' }, { status: 500 });
  }
}

/**
 * POST /api/cdn/files  (multipart/form-data: file, filename?, folderId? or folderPath?)
 * Company model: the uploader is the ACTOR; ownership is attributed to them
 * (name/email snapshotted) and the file joins the shared company pool.
 *
 * `folderId` places the file inside a real nested folder (unlimited depth);
 * `folderPath` (e.g. "Tirbeo/Design") is also accepted for convenience.
 */
export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  try {
    const contentType = request.headers.get('content-type') || '';
    let bytes: Buffer | null = null;
    let filename = '';
    let mimeType = '';
    let folderId: string | null = null;
    let folderPathRaw = '';
    let visibilityField = '';

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json({ error: 'file field is required' }, { status: 400 });
      }
      const customName = (form.get('filename') as string | null) || '';
      filename = customName || file.name;
      mimeType = file.type || 'application/octet-stream';
      bytes = Buffer.from(await file.arrayBuffer());
      folderId = (form.get('folderId') as string | null) || null;
      folderPathRaw = (form.get('folderPath') as string | null) || '';
      visibilityField = (form.get('visibility') as string | null) || '';
    } else {
      // Raw body upload — filename + mime via query/headers.
      const url = new URL(request.url);
      filename = url.searchParams.get('filename') || request.headers.get('x-file-name') || 'untitled';
      mimeType = request.headers.get('x-file-type') || 'application/octet-stream';
      folderId = url.searchParams.get('folderId');
      folderPathRaw = url.searchParams.get('folderPath') || '';
      visibilityField = url.searchParams.get('visibility') || request.headers.get('x-file-visibility') || '';
      bytes = Buffer.from(await request.arrayBuffer());
    }

    const safeName = filename.trim().slice(0, 255) || 'untitled';
    if (bytes && bytes.length > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit.` },
        { status: 413 },
      );
    }

    // Resolve the destination folder: explicit id, else by path (created on
    // the fly so drag-dropped deep paths never fail).
    let parentId: string | null = folderId || null;
    if (!parentId && folderPathRaw) {
      const segments = folderPathRaw.split('/').map((s) => s.trim()).filter(Boolean);
      const existing = await getFolderByPath(segments);
      if (existing) {
        parentId = existing.id;
      } else {
        // Auto-create the missing chain.
        let parent: string | null = null;
        for (const segment of segments) {
          const created = await uploadCdnFile({
            userId: session.userId,
            filename: segment,
            contentType: 'application/x-tirbeo-folder',
            bytes: Buffer.alloc(0),
            folder: true,
            parentId: parent,
          });
          parent = created.id;
        }
        parentId = parent;
      }
    }

    // Owner attribution snapshot (actor = owner on upload).
    const profile = await getActorProfile(session.userId);

    const file = await uploadCdnFile({
      userId: session.userId,
      filename: safeName,
      contentType: mimeType,
      bytes,
      parentId,
      owner: { id: session.userId, name: profile.name, email: profile.email },
      visibility: visibilityField === 'private' ? 'private' : 'public',
    });

    return NextResponse.json({ file }, { status: 201 });
  } catch (err: any) {
    const status = err?.statusCode || 500;
    console.error('[CDN] Upload failed:', err?.message);
    return NextResponse.json({ error: err?.message || 'Upload failed' }, { status });
  }
}

/**
 * PUT /api/cdn/files — create a folder (nested, unlimited depth).
 * Body: { name, parentId? } or { name, folderPath? }. Realtime event pushed
 * to every connected client; activity logged server-side.
 */
export async function PUT(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  try {
    const body: any = await request.json().catch(() => ({}));
    const name = String(body?.name ?? '').trim().slice(0, 255);
    if (!name) {
      return NextResponse.json({ error: 'Folder name is required' }, { status: 400 });
    }
    const parentId: string | null = typeof body?.parentId === 'string' && body.parentId ? body.parentId : null;
    const profile = await getActorProfile(session.userId);
    const folder = await uploadCdnFile({
      userId: session.userId,
      filename: name,
      contentType: 'application/x-tirbeo-folder',
      bytes: Buffer.alloc(0),
      folder: true,
      parentId,
      owner: { id: session.userId, name: profile.name, email: profile.email },
    });
    return NextResponse.json({ file: folder }, { status: 201 });
  } catch (err: any) {
    const status = err?.statusCode || 500;
    if (status >= 500) console.error('[CDN] Folder create failed:', err?.message);
    return NextResponse.json({ error: err?.message || 'Folder create failed' }, { status });
  }
}
