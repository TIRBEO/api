import { NextRequest, NextResponse } from 'next/server';
import { requireSession, getAdminRole, roleAtLeast } from '@/features/auth/http-guards';
import { isCockroachHealthy } from '@/infrastructure/db/cockroach';
import {
  renameCdnFile,
  moveCdnFile,
  setCdnFileStarred,
  setSelfDestruct,
  moveToTrash,
  restoreFromTrash,
  permanentlyDeleteCdnFile,
  getCdnFileMeta,
  attachSelfDestruct,
  setCdnFileVisibility,
  logCdnActivity,
  type CdnFileDto,
} from '@/features/media/cdnStorage';

export const runtime = 'nodejs';

// ── Company deletion policy ──
// Trash/restore are open to every member; PERMANENT deletion of company
// files requires manager, admin, or super_admin.
async function canPermanentDelete(userId: string): Promise<boolean> {
  const role = await getAdminRole(userId);
  return !!role && roleAtLeast(role, 'manager');
}

async function denyPermanentDelete(userId: string, fileId: string): Promise<NextResponse> {
  // Denials are logged too — the audit trail shows who tried what.
  logCdnActivity({
    userId,
    type: 'cdn.file.delete_denied',
    fileId,
    metadata: { reason: 'insufficient_role', requiredRole: 'manager' },
  }).catch(() => {});
  return NextResponse.json(
    { error: 'Only managers and admins can permanently delete company files.' },
    { status: 403 },
  );
}

type ActionMutation =
  | { action: 'rename'; filename: string }
  | { action: 'star'; starred: boolean }
  | { action: 'self-destruct'; expiresAt: number | null }
  | { action: 'trash' }
  | { action: 'restore' }
  | { action: 'move'; parentId: string | null }
  | { action: 'visibility'; visibility: 'public' | 'private' }
  | { action: 'delete-permanent' };

/** Flat shape the CDN web app sends: { filename?, starred?, trashed?, selfDestructAt?, visibility? }. */
interface FlatMutation {
  filename?: string;
  starred?: boolean;
  trashed?: boolean;
  selfDestructAt?: number | null;
  visibility?: 'public' | 'private';
}

/** Coerce a request body (either dialect) into an ordered list of mutations. */
function parseMutations(body: any): ActionMutation[] {
  const mutations: ActionMutation[] = [];
  if (!body || typeof body !== 'object') return mutations;

  if (typeof body.action === 'string') {
    switch (body.action) {
      case 'rename':
        if (typeof body.filename === 'string') mutations.push({ action: 'rename', filename: body.filename });
        break;
      case 'star':
        if (typeof body.starred === 'boolean') mutations.push({ action: 'star', starred: body.starred });
        break;
      case 'visibility':
        if (body.visibility === 'public' || body.visibility === 'private') {
          mutations.push({ action: 'visibility', visibility: body.visibility });
        }
        break;
      case 'self-destruct':
        mutations.push({ action: 'self-destruct', expiresAt: body.expiresAt ?? null });
        break;
      case 'trash':
        mutations.push({ action: 'trash' });
        break;
      case 'restore':
        mutations.push({ action: 'restore' });
        break;
      case 'move':
        mutations.push({ action: 'move', parentId: body.parentId ?? null });
        break;
      case 'delete-permanent':
        mutations.push({ action: 'delete-permanent' });
        break;
    }
    return mutations;
  }

  // Flat dialect (what apps/cdn actually sends).
  const flat = body as FlatMutation;
  if (typeof flat.filename === 'string') mutations.push({ action: 'rename', filename: flat.filename });
  if (typeof flat.starred === 'boolean') mutations.push({ action: 'star', starred: flat.starred });
  if (flat.visibility === 'public' || flat.visibility === 'private') {
    mutations.push({ action: 'visibility', visibility: flat.visibility });
  }
  if ('selfDestructAt' in flat) {
    const v = flat.selfDestructAt;
    mutations.push({ action: 'self-destruct', expiresAt: typeof v === 'number' ? v : null });
  }
  if (flat.trashed === true) mutations.push({ action: 'trash' });
  if (flat.trashed === false) mutations.push({ action: 'restore' });
  return mutations;
}

/**
 * Company-wide CDN routes — any authenticated member can read and edit any
 * organization file. Every mutation is actor-logged server-side.
 *
 * GET    /api/cdn/files/[id] — single file metadata
 * PATCH  /api/cdn/files/[id] — rename / star / self-destruct / trash / restore
 * DELETE /api/cdn/files/[id] — permanent delete
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  try {
    const file = await getCdnFileMeta(id);
    return NextResponse.json({ file });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Not found' }, { status: err?.statusCode || 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  const { id } = await params;
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const mutations = parseMutations(body);
  if (mutations.length === 0) {
    return NextResponse.json(
      { error: 'Nothing to update. Use filename | starred | trashed | selfDestructAt (or action: rename|star|self-destruct|trash|restore)' },
      { status: 400 },
    );
  }

  const actorId = session.userId;
  try {
    let file: CdnFileDto | null = null;
    for (const m of mutations) {
      switch (m.action) {
        case 'rename':
          file = await renameCdnFile(actorId, id, m.filename);
          break;
        case 'star':
          file = await setCdnFileStarred(actorId, id, m.starred);
          break;
        case 'self-destruct': {
          const expiresAt = m.expiresAt;
          if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
            return NextResponse.json({ error: 'Invalid expiry timestamp' }, { status: 400 });
          }
          await setSelfDestruct(actorId, id, expiresAt);
          file = await getCdnFileMeta(id);
          break;
        }
        case 'trash':
          file = await moveToTrash(actorId, id);
          break;
        case 'restore':
          file = await restoreFromTrash(actorId, id);
          break;
        case 'move':
          file = await moveCdnFile(actorId, id, m.parentId);
          break;
        case 'visibility':
          file = await setCdnFileVisibility(actorId, id, m.visibility);
          break;
        case 'delete-permanent':
          if (!(await canPermanentDelete(actorId))) {
            return await denyPermanentDelete(actorId, id);
          }
          await permanentlyDeleteCdnFile(actorId, id);
          return NextResponse.json({ success: true, deleted: true });
      }
    }
    const [withSd] = await attachSelfDestruct([file!]);
    return NextResponse.json({ file: withSd, success: true });
  } catch (err: any) {
    const status = err?.statusCode || 500;
    if (status >= 500) console.error('[CDN] Mutation failed:', err?.message);
    return NextResponse.json({ error: err?.message || 'Update failed' }, { status });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  const { id } = await params;
  if (!(await canPermanentDelete(session.userId))) {
    return await denyPermanentDelete(session.userId, id);
  }
  try {
    await permanentlyDeleteCdnFile(session.userId, id);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    const status = err?.statusCode || 500;
    return NextResponse.json({ error: err?.message || 'Delete failed' }, { status });
  }
}
