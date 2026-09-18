import { NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { pathInScope } from '@/features/media/cdnPath';
import {
  listAllCdnFiles,
  uploadCdnFile,
  getCdnFileMeta,
  getCdnFileBytes,
  renameCdnFile,
  moveCdnFile,
  moveToTrash,
  restoreFromTrash,
  permanentlyDeleteCdnFile,
  setCdnFileVisibility,
  getOrgStorageUsageBytes,
  getActorProfile,
  MAX_UPLOAD_BYTES,
  type CdnFileDto,
} from '@/features/media/cdnStorage';

// ═══ Tirbeo CDN v1 shared helpers ═══
// Public model: folders + files addressed by canonical path — no buckets.
// All sizes are integer BYTES. Timestamps are epoch millis.

/**
 * Public CDN base URL, environment-aware:
 * - explicit `CDN_PUBLIC_BASE_URL` wins when set,
 * - production uses `https://cdn.tirbeo.app`,
 * - local dev serves the CDN app on :4400, so signed/file URLs point there.
 */
function resolveCdnPublicBase(): string {
  const configured = (process.env.CDN_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return 'https://cdn.tirbeo.app';
  const port = (process.env.CDN_PORT || '4400').trim() || '4400';
  return `http://localhost:${port}`;
}

export const CDN_PUBLIC_BASE = resolveCdnPublicBase();

/** Hostname only (no scheme/port) — for DNS CNAME targets. */
export function cdnPublicHostname(): string {
  try {
    return new URL(CDN_PUBLIC_BASE).hostname;
  } catch {
    return 'cdn.tirbeo.app';
  }
}

/** Normalize any numeric input to integer bytes. */
export function toBytes(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

export interface V1File {
  id: string;
  name: string;
  /** Canonical path, no leading slash: `avatars/users/usr_123/profile.webp`. */
  path: string;
  mimeType: string;
  /** BYTES */
  size: number;
  visibility: 'public' | 'private';
  status: string;
  createdAt: number;
  updatedAt: number;
  /** Canonical public delivery URL: {base}/u/a/{path}. */
  url: string;
}

export function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

export function v1FileFromDto(dto: CdnFileDto): V1File {
  // Prefer the resolved folder chain; fall back to the stored filename
  // (legacy flat rows embed prefixes like `images/x.webp`).
  const chain = Array.isArray((dto as { path?: unknown }).path)
    ? (dto.path as string[]).join('/')
    : '';
  const full = chain || dto.filename || '';
  const name = full.split('/').pop() || full;
  const size = toBytes((dto as { size?: unknown }).size);
  const vis = (dto as { visibility?: unknown }).visibility;
  return {
    id: dto.id,
    name,
    path: full,
    mimeType: dto.contentType,
    size,
    visibility: vis === 'private' ? 'private' : 'public',
    status: dto.trashed ? 'deleted' : 'active',
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    url: `${CDN_PUBLIC_BASE}/u/a/${encodePath(full)}`,
  };
}

/** Top-level folder usage (storage + object counts) for the usage endpoints. */
export async function listTopFolderUsage(): Promise<Record<string, { storage: number; objects: number }>> {
  const { active } = await listAllCdnFiles().catch(() => ({ active: [] as CdnFileDto[], trash: [] as CdnFileDto[] }));
  const byFolder: Record<string, { storage: number; objects: number }> = {};
  for (const f of active) {
    if (f.folder) continue;
    const v = v1FileFromDto(f);
    const top = v.path.includes('/') ? v.path.split('/')[0] : '(home)';
    const cur = byFolder[top] ?? { objects: 0, storage: 0 };
    cur.objects += 1;
    cur.storage += v.size;
    byFolder[top] = cur;
  }
  return byFolder;
}

/** Find an active file/folder DTO by canonical path (no leading slash). */
export async function getDtoByCanonicalPath(canonical: string): Promise<CdnFileDto | null> {
  const { active } = await listAllCdnFiles();
  const hit = active.find((f) => {
    const full = (Array.isArray(f.path) && f.path.length > 0 ? f.path.join('/') : f.filename).replace(/^\/+/, '');
    return full === canonical;
  });
  return hit ?? null;
}

/** List direct children (files + folders) of a canonical folder path. */
export async function listDtoChildren(canonicalFolder: string): Promise<{ folders: V1File[]; files: V1File[] }> {
  const { active } = await listAllCdnFiles();
  const folders: V1File[] = [];
  const files: V1File[] = [];
  const seenFolders = new Set<string>();
  for (const f of active) {
    const full = (Array.isArray(f.path) && f.path.length > 0 ? f.path.join('/') : f.filename).replace(/^\/+/, '');
    if (canonicalFolder) {
      if (full !== canonicalFolder && !full.startsWith(`${canonicalFolder}/`)) continue;
      const rest = full === canonicalFolder ? '' : full.slice(canonicalFolder.length + 1);
      if (rest === '') {
        if (f.folder) folders.push(v1FileFromDto(f));
        continue;
      }
      if (!rest.includes('/')) {
        (f.folder ? folders : files).push(v1FileFromDto(f));
      } else if (!f.folder) {
        const first = rest.split('/')[0];
        const folderPath = `${canonicalFolder}/${first}`;
        if (!seenFolders.has(folderPath)) {
          seenFolders.add(folderPath);
          folders.push({
            id: `folder:${folderPath}`,
            name: first,
            path: folderPath,
            mimeType: 'application/x-tirbeo-folder',
            size: 0,
            visibility: 'public',
            status: 'active',
            createdAt: f.createdAt,
            updatedAt: f.updatedAt,
            url: `${CDN_PUBLIC_BASE}/u/a/${encodePath(folderPath)}`,
          });
        }
      }
    } else if (!full.includes('/')) {
      (f.folder ? folders : files).push(v1FileFromDto(f));
    } else if (!f.folder) {
      const first = full.split('/')[0];
      if (!seenFolders.has(first)) {
        seenFolders.add(first);
        folders.push({
          id: `folder:${first}`,
          name: first,
          path: first,
          mimeType: 'application/x-tirbeo-folder',
          size: 0,
          visibility: 'public',
          status: 'active',
          createdAt: f.createdAt,
          updatedAt: f.updatedAt,
          url: `${CDN_PUBLIC_BASE}/u/a/${encodePath(first)}`,
        });
      }
    }
  }
  return { folders, files };
}

// ═══ Upload sessions (single-instance memory; sizes in BYTES) ═══
export interface UploadSession {
  id: string;
  filename: string;
  /** total BYTES */
  size: number;
  mimeType: string;
  /** Canonical destination path (no leading slash). */
  destPath?: string;
  /** Public (no login) or private (signed URL only) on completion. */
  visibility?: 'public' | 'private';
  /** BYTES received so far */
  received: number;
  status: 'created' | 'uploading' | 'processing' | 'complete' | 'failed' | 'cancelled' | 'expired';
  createdAt: number;
}

const uploadSessions = new Map<string, UploadSession>();

export function createUploadSession(s: Omit<UploadSession, 'received' | 'status' | 'createdAt'>): UploadSession {
  const full: UploadSession = {
    ...s,
    size: toBytes(s.size),
    received: 0,
    status: 'created',
    createdAt: Date.now(),
    visibility: s.visibility === 'private' ? 'private' : 'public',
  };
  uploadSessions.set(full.id, full);
  if (uploadSessions.size > 500) {
    const first = uploadSessions.keys().next().value;
    if (first) uploadSessions.delete(first);
  }
  return full;
}

export function getUploadSession(id: string): UploadSession | null {
  return uploadSessions.get(id) ?? null;
}

export function markUploadProgress(id: string, receivedBytes: number) {
  const s = uploadSessions.get(id);
  if (!s) return;
  s.received = Math.min(s.size, toBytes(receivedBytes));
  s.status = s.received >= s.size ? 'complete' : 'uploading';
}

export { listAllCdnFiles, uploadCdnFile, getCdnFileMeta, getCdnFileBytes, renameCdnFile, moveCdnFile, moveToTrash, restoreFromTrash, permanentlyDeleteCdnFile, setCdnFileVisibility, getOrgStorageUsageBytes, getActorProfile, MAX_UPLOAD_BYTES };
export type { CdnFileDto };

export function json(data: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(data, { status, headers });
}

// ═══ PRD §53–54: standard response envelope ═══

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ data }, { status });
}

export function created<T>(data: T) {
  return NextResponse.json({ data }, { status: 201 });
}

export function paged<T>(data: T[], nextCursor: string | null) {
  return NextResponse.json({ data, pagination: { has_more: nextCursor != null, next_cursor: nextCursor } });
}

export function apiError(code: string, message: string, status = 400) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// ═══ PRD §55–57: key → project → path-scope → permission → operation ═══

export interface KeyScope {
  keyId: string;
  keyType: 'dashboard' | 'cdn';
  pathScopes: string[] | null;
  keyPermissions: string[] | null;
}

type SessionLike = { userId: string; keyScope?: KeyScope } | NextResponse;

export function sessionScope(session: unknown): KeyScope | null {
  const s = session as { keyScope?: KeyScope } | null;
  return s?.keyScope ?? null;
}

/**
 * Enforce a CDN permission + path scope. Session (dashboard) auth always
 * passes. API keys must carry the permission and cover the path.
 * Returns an error Response when denied, else null.
 */
export function requireCdnAccess(
  session: unknown,
  permission: string,
  requestPath?: string | null,
): NextResponse | null {
  const scope = sessionScope(session);
  if (!scope) return null; // dashboard session — full access
  if (scope.keyPermissions && !scope.keyPermissions.includes(permission)) {
    return apiError('FORBIDDEN', `API key lacks the ${permission} permission.`, 403);
  }
  if (requestPath != null && scope.pathScopes) {
    const allowed = scope.pathScopes.some((s) => pathInScope(requestPath, s));
    if (!allowed) {
      return apiError('FORBIDDEN', 'API key scope does not cover this path.', 403);
    }
  }
  return null;
}

/** Parse `?limit=` (1..500, default 100) for cursor pagination. */
export function parseLimit(searchParams: URLSearchParams, def = 100): number {
  const n = parseInt(searchParams.get('limit') || String(def), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(500, Math.max(1, n));
}
