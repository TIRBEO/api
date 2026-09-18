import { randomUUID, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  getCockroachPool,
  ensureCockroachSchema,
  toMillis,
  withCockroachRetry,
  type CrdbTimestamp,
} from '@/infrastructure/db/cockroach';
import { prisma } from '@/infrastructure/db/prisma';
import { publishCdnEvent } from '@/features/media/cdnRealtime';
import { invalidateThumbCache } from '@/features/media/cdnThumb';
import { takePrewarmedBytes, warmBytesDirect, dropPrewarmed, alertCreatorShareRedeemed, AUTO_WARM_MAX_BYTES } from '@/features/media/cdnControl';

// ═══ LIMITS (company-wide CDN) ═══
// Storage is a single institutional pool shared by ALL privileged users.
// Storage is UNLIMITED — no org-wide cap; only per-file upload size is capped.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB per file
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SELF_DESTRUCT_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days cap
export const PUBLIC_OWNER_ALIAS = 'a'; // /u/a/<folders>/<file>

// ═══ TYPES ═══

/** Raw row shape as returned by node-postgres (snake_case column names). */
interface CdnFileRow {
  id: string;
  user_id: string; // uploader of record
  owner_id: string | null; // owner attribution (company model)
  owner_name: string | null;
  owner_email: string | null;
  filename: string;
  s3_key: string;
  mime_type: string;
  size: string | number;
  starred: boolean;
  deleted: boolean;
  folder?: boolean;
  parent_id?: string | null;
  visibility?: string | null;
  created_at: CrdbTimestamp;
  updated_at: CrdbTimestamp;
  last_opened_at: CrdbTimestamp;
  content?: Buffer;
}

/** Shape the CDN client understands (all timestamps as epoch ms). */
export interface CdnFileDto {
  id: string;
  filename: string;
  s3Key: string;
  contentType: string;
  size: number;
  starred: boolean;
  trashed: boolean;
  /** True for folder rows (nested folders, unlimited depth). */
  folder: boolean;
  /** Parent folder id — null for top-level items. */
  parentId: string | null;
  /** Per-file visibility gate: 'public' (no login) or 'private' (signed URL). */
  visibility: 'public' | 'private';
  /** Full path from the workspace root, e.g. ["Tirbeo","Design","Logos"]. */
  path: string[];
  /** Owner attribution — who added the file on behalf of the company. */
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  /** Resolved lazily per-list (batched + cached) for UI avatars. */
  ownerPhotoUrl?: string | null;
  selfDestructAt: number | null;
  trashedAt: number | null;
  lastOpenedAt: number | null;
  createdAt: number;
  updatedAt: number;
  timestamp: number;
}

const LIST_COLUMNS = `id, user_id, owner_id, owner_name, owner_email, filename, s3_key, mime_type, size, starred, deleted, folder, parent_id, visibility, created_at, updated_at, last_opened_at`;

/** Same columns, qualified for queries that JOIN cdn_files AS f (else
 *  `user_id` is ambiguous against cdn_file_opens and Postgres errors). */
const LIST_COLUMNS_F = `f.id, f.user_id, f.owner_id, f.owner_name, f.owner_email, f.filename, f.s3_key, f.mime_type, f.size, f.starred, f.deleted, f.folder, f.parent_id, f.visibility, f.created_at, f.updated_at, f.last_opened_at`;

// In-memory path map (id → breadcrumb), rebuilt lazily and invalidated on
// rename/trash/create. Keeps listing O(1) per file without recursive queries.
let pathMap: Map<string, string[]> | null = null;
function invalidatePathMap(): void {
  pathMap = null;
  // Resolved-bytes cache is keyed by path — a rename/move/trash must not
  // leave stale paths serving (or serving the wrong bytes).
  pathCache.clear();
  invalidateChainMeta();
}

/** Drop only the path-cache entries for one file id. Used cross-instance: a
 *  visibility flip arriving via the Redis event bus must take effect here
 *  immediately, not after the 15-minute TTL. */
function invalidatePathCacheForFile(fileId: string): void {
  for (const [key, val] of pathCache) {
    if (val && typeof val === 'object' && (val as { fileId?: string }).fileId === fileId) {
      pathCache.delete(key);
    }
  }
}

// Cross-instance invalidation: bind ONCE per process. The Redis bus fans every
// change event to all instances; visibility flips are security-relevant, so the
// local path cache must be dropped as soon as a peer flips the file.
let cacheInvalidationBound = false;
function bindCrossInstanceInvalidation(): void {
  if (cacheInvalidationBound) return;
  cacheInvalidationBound = true;
  import('@/features/media/cdnRealtime')
    .then(({ subscribeCdnEvents }) => {
      subscribeCdnEvents((event) => {
        if (event.type === 'cdn.file.make_public' || event.type === 'cdn.file.make_private') {
          invalidatePathCacheForFile(event.fileId);
        }
      });
    })
    .catch(() => {});
}

/** id → full breadcrumb path. Empty name segments collapse to "". */
async function buildPathMap(): Promise<Map<string, string[]>> {
  if (pathMap) return pathMap;
  await ensureCockroachSchema();
  const pool = getCockroachPool();
  const res = await withCockroachRetry(() =>
    pool.query(`SELECT id, filename, folder, parent_id FROM cdn_files WHERE deleted = false`),
  );
  const byId = new Map<string, { name: string; parent: string | null; folder: boolean }>();
  for (const r of res.rows as any[]) {
    byId.set(r.id, { name: r.filename, parent: r.parent_id || null, folder: !!r.folder });
  }
  const paths = new Map<string, string[]>();
  const resolve = (id: string, stack: Set<string>): string[] => {
    const cached = paths.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    if (!node || stack.has(id)) {
      paths.set(id, []);
      return [];
    }
    stack.add(id);
    const parentPath = node.parent ? resolve(node.parent, stack) : [];
    stack.delete(id);
    const full = [...parentPath, node.name];
    paths.set(id, full);
    return full;
  };
  for (const id of byId.keys()) resolve(id, new Set());
  pathMap = paths;
  return paths;
}

function rowToDto(row: CdnFileRow, paths?: Map<string, string[]>): CdnFileDto {
  const createdAt = toMillis(row.created_at) ?? Date.now();
  const updatedAt = toMillis(row.updated_at) ?? createdAt;
  const path = paths?.get(row.id) ?? [];
  return {
    id: row.id,
    filename: row.filename,
    s3Key: row.s3_key,
    contentType: row.mime_type || 'application/octet-stream',
    size: Number(row.size ?? 0),
    starred: !!row.starred,
    trashed: !!row.deleted,
    folder: !!row.folder,
    parentId: row.parent_id || null,
    visibility: row.visibility === 'private' ? 'private' : 'public',
    path,
    ownerId: row.owner_id || row.user_id,
    ownerName: row.owner_name ?? null,
    ownerEmail: row.owner_email ?? null,
    selfDestructAt: null, // merged later via attachSelfDestruct
    trashedAt: row.deleted ? updatedAt : null,
    lastOpenedAt: toMillis(row.last_opened_at),
    createdAt,
    updatedAt,
    timestamp: createdAt,
  };
}

/** Run a query with schema bootstrap + transient-error retry. */
async function q<T = any>(sql: string, params: unknown[] = [], ensure = false): Promise<T> {
  if (ensure) await ensureCockroachSchema();
  const pool = getCockroachPool();
  return withCockroachRetry(() => pool.query(sql, params)) as Promise<T>;
}

// ═══ ACTIVITY & LOGS (Supabase — metadata + logs live here) ═══

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  '';

/** Supabase client is created once per process and reused. */
let supabasePromise: Promise<any> | null = null;
async function getSupabase(): Promise<any | null> {
  if (!supabaseUrl || !supabaseKey) return null;
  if (!supabasePromise) {
    supabasePromise = import('@supabase/supabase-js').then(({ createClient }) =>
      createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } }),
    );
  }
  return supabasePromise;
}

// The same bad-key error fires once per write — spamming it per request is
// noise. Log each unique message once per process; fallback writes continue.
const seenActivityErrors = new Set<string>();
function warnActivityError(scope: string, message: string): void {
  const key = `${scope}:${message}`;
  if (seenActivityErrors.has(key)) return;
  seenActivityErrors.add(key);
  console.error(`[CDN-ACTIVITY] ${scope} failed (will fall back, not logged again): ${message}`);
}

/**
 * Record a CDN activity log to Supabase (`user_activity`) — best-effort,
 * never blocks or fails the request. Every company-file action is logged:
 * who (actor), what (type), which file, and metadata.
 * Falls back to the API's own `cdn_activity` table via Prisma when Supabase
 * isn't configured or the write fails, so the audit trail is never lost.
 */
export async function logCdnActivity(input: {
  userId: string; // actor
  type: string;
  fileId?: string | null;
  filename?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const metadata = input.metadata ?? {};
  try {
    const supabase = await getSupabase();
    if (supabase) {
      const { error } = await supabase.from('user_activity').insert({
        user_id: input.userId,
        type: input.type,
        file_id: input.fileId ?? null,
        filename: input.filename ?? null,
        metadata,
      });
      if (!error) return;
      warnActivityError('Supabase write', error.message);
    }
  } catch (err: any) {
    warnActivityError('Supabase write', err?.message);
  }
  // Fallback: keep the log on the API's own Postgres (Supabase) via Prisma.
  try {
    await prisma.cdnActivity.create({
      data: {
        type: input.type,
        fileId: input.fileId ?? null,
        actor: input.userId,
        metadata: { ...(metadata as any), filename: input.filename ?? undefined },
      },
    });
  } catch (err: any) {
    warnActivityError('Fallback activity write', err?.message);
  }
}

/** Resolve an actor's display identity once per request for logs + attribution. */
export async function getActorProfile(userId: string): Promise<{ name: string | null; email: string | null }> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    return { name: user?.name ?? null, email: user?.email ?? null };
  } catch {
    return { name: null, email: null };
  }
}

// ─── Owner avatar resolution (batched, TTL-cached — one query per list) ───

const ownerPhotoCache = new Map<string, { url: string | null; at: number }>();
const OWNER_PHOTO_TTL_MS = 300_000; // 5 min

/** Fill ownerPhotoUrl on dtos with ONE batched user query (cached 5 min). */
export async function attachOwnerPhotos(dtos: CdnFileDto[]): Promise<CdnFileDto[]> {
  if (dtos.length === 0) return dtos;
  const now = Date.now();
  const missing = new Set<string>();
  for (const d of dtos) {
    const cached = ownerPhotoCache.get(d.ownerId);
    if (!cached || now - cached.at > OWNER_PHOTO_TTL_MS) missing.add(d.ownerId);
  }
  if (missing.size > 0) {
    try {
      const users = await prisma.user.findMany({
        where: { id: { in: [...missing] } },
        select: { id: true, photoUrl: true },
      });
      for (const id of missing) {
        const u = users.find((x) => x.id === id);
        ownerPhotoCache.set(id, { url: u?.photoUrl ?? null, at: now });
      }
    } catch {
      // Avatars stay null — UI falls back to initials.
    }
  }
  for (const d of dtos) {
    d.ownerPhotoUrl = ownerPhotoCache.get(d.ownerId)?.url ?? null;
  }
  return dtos;
}

// ═══ ACTIVITY FEED (company-wide audit of every cdn.* event) ═══

export interface CdnActivityEntry {
  id: string;
  type: string;
  actorId: string;
  actorName: string | null;
  actorEmail: string | null;
  fileId: string | null;
  filename: string | null;
  metadata: Record<string, unknown>;
  createdAt: number; // epoch ms
}

/**
 * Recent company CDN activity. Reads the `user_activity` table (Supabase),
 * enriched with actor names from the API's own user records. Falls back to
 * the Prisma `cdn_activity` table when Supabase is unavailable/empty (the
 * fallback table stores the same events via logCdnActivity).
 */
export async function listCdnActivity(limit = 100): Promise<CdnActivityEntry[]> {
  const cap = Math.min(Math.max(limit, 1), 500);

  type RawEvent = {
    id: string;
    type: string;
    user_id?: string | null;
    actor?: string | null;
    file_id?: string | null;
    filename?: string | null;
    metadata?: Record<string, unknown> | null;
    created_at?: string | null;
  };

  let raw: RawEvent[] = [];
  let source: 'supabase' | 'prisma' = 'prisma';
  try {
    const supabase = await getSupabase();
    if (supabase) {
      const { data, error } = await supabase
        .from('user_activity')
        .select('id, type, user_id, file_id, filename, metadata, created_at')
        .like('type', 'cdn.%')
        .order('created_at', { ascending: false })
        .limit(cap);
      if (!error && data) {
        raw = data as RawEvent[];
        source = 'supabase';
      }
    }
  } catch {
    // fall through to Prisma
  }

  if (source !== 'supabase') {
    try {
      const rows = await prisma.cdnActivity.findMany({
        orderBy: { createdAt: 'desc' },
        take: cap,
      });
      raw = rows.map((r) => ({
        id: r.id,
        type: r.type,
        actor: r.actor,
        file_id: r.fileId,
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
        created_at: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      }));
    } catch {
      raw = [];
    }
  }

  // Enrich actor names — one batched query for all distinct actor ids.
  const actorIds = [...new Set(raw.map((r) => r.user_id || r.actor || '').filter(Boolean))];
  const actorMap = new Map<string, { name: string | null; email: string | null }>();
  if (actorIds.length > 0) {
    try {
      const users = await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      });
      for (const u of users) actorMap.set(u.id, { name: u.name, email: u.email });
    } catch {
      // names stay null — feed still works
    }
  }

  return raw.map((r) => {
    const actorId = r.user_id || r.actor || '';
    const actor = actorMap.get(actorId);
    return {
      id: r.id,
      type: r.type,
      actorId,
      actorName: actor?.name ?? null,
      actorEmail: actor?.email ?? null,
      fileId: r.file_id ?? null,
      filename: r.filename ?? (r.metadata as any)?.filename ?? null,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
    };
  });
}

// ─── Storage usage (CockroachDB — ORG-wide, UNLIMITED) ───

export async function getOrgStorageUsageBytes(): Promise<number> {
  const res = await q(
    `SELECT COALESCE(sum(size), 0)::INT8 AS total FROM cdn_files WHERE deleted = false`,
  );
  return Number(res.rows[0]?.total ?? 0);
}

// ─── Folder resolution (nested folders, unlimited depth) ───

/** Find a folder row by its parent + name. */
async function findFolderByName(parentId: string | null, name: string): Promise<{ id: string } | null> {
  const res = await q(
    `SELECT id FROM cdn_files WHERE folder = true AND deleted = false AND filename = $1 AND ${parentId ? 'parent_id = $2' : '(parent_id IS NULL)'} LIMIT 1`,
    parentId ? [name, parentId] : [name],
  );
  return res.rows[0] ?? null;
}

/**
 * Resolve a public path to its file id via a METADATA-ONLY table scan
 * (no content blobs — the columns fetched are tiny) + an in-process walk.
 * A recursive CTE was measured at 17s on CockroachDB (the optimizer full-
 * scanned blob rows per level); this path never touches the content column
 * except for the final single-row bytes fetch.
 * Returns the id only — bytes are fetched separately by the caller.
 */
let chainMeta: { rows: { id: string; parent: string | null; name: string; folder: boolean }[]; at: number } | null = null;
// 5 min: metadata-only (renames/moves/trash call invalidatePathMap() →
// invalidateChainMeta(), so staleness is bounded by mutation, not time).
const CHAIN_META_TTL_MS = 5 * 60_000;

async function resolvePathToFileId(folderPath: string[], filename: string): Promise<string | null> {
  const dec = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
  const now = Date.now();
  if (!chainMeta || now - chainMeta.at > CHAIN_META_TTL_MS) {
    const res = await q(
      // Covered by idx_cdn_files_meta (deleted STORING parent_id, filename,
      // folder) — this scan never touches the blob-carrying primary index.
      `SELECT id, parent_id, filename, folder FROM cdn_files@idx_cdn_files_meta WHERE deleted = false`,
    );
    chainMeta = {
      rows: (res.rows as any[]).map((r) => ({
        id: r.id as string,
        parent: (r.parent_id as string | null) ?? null,
        name: r.filename as string,
        folder: !!r.folder,
      })),
      at: now,
    };
  }
  const eq = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase();
  let parentId: string | null = null;
  for (const raw of folderPath) {
    const seg = dec(raw);
    const hit = chainMeta.rows.find((r) => r.folder && r.parent === parentId && eq(r.name, seg));
    if (!hit) return null;
    parentId = hit.id;
  }
  const name = dec(filename);
  const fileHit = chainMeta.rows.find((r) => !r.folder && r.parent === parentId && eq(r.name, name));
  return fileHit?.id ?? null;
}

// chainMeta must reset with the path map — renames/moves change the chains.
function invalidateChainMeta(): void {
  chainMeta = null;
}

/** Case-insensitive folder fallback — "Images" links keep working after a
 *  rename to "images" even before any alias is recorded. */
async function findFolderByNameCI(parentId: string | null, name: string): Promise<{ id: string } | null> {
  const res = await q(
    `SELECT id FROM cdn_files WHERE folder = true AND deleted = false AND lower(filename) = lower($1) AND ${parentId ? 'parent_id = $2' : '(parent_id IS NULL)'} LIMIT 1`,
    parentId ? [name, parentId] : [name],
  );
  return res.rows[0] ?? null;
}

// ─── Public path aliases (links survive folder/file renames + moves) ───
// Every historical folder-chain path a file has lived under is recorded in
// cdn_path_aliases, so /u/a/Images/x.png keeps resolving after Images is
// renamed to "images" or moved deeper. Resolution order: exact live path →
// case-insensitive live path → alias table.

const aliasCache = new Map<string, { fileId: string | null; at: number }>();
const ALIAS_CACHE_TTL_MS = 60_000;
const ALIAS_CACHE_MAX = 1000;

/** Alias key: lowercased folder chain + exact filename (decoded segments). */
function aliasKeyFor(folderPath: string[], filename: string): string {
  const dec = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
  return [...folderPath.map((s) => dec(s).toLowerCase()), dec(filename)].join('/');
}

/** Every casing-variant alias keys for a path (folders are case-tolerant). */
function aliasKeysFor(folderPath: string[], filename: string): string[] {
  const base = aliasKeyFor(folderPath, filename);
  const keys = new Set<string>([base, base.toUpperCase(), base
    .split('/')
    .map((seg, i, arr) => (i < arr.length - 1 ? seg.toLowerCase() : seg))
    .join('/')]);
  return [...keys];
}

async function lookupAlias(aliasPath: string): Promise<string | null> {
  const cached = aliasCache.get(aliasPath);
  if (cached && Date.now() - cached.at < ALIAS_CACHE_TTL_MS) return cached.fileId;
  const res = await q(
    `SELECT file_id FROM cdn_path_aliases WHERE alias_path = $1 LIMIT 1`,
    [aliasPath],
  ).catch(() => null);
  const fileId = (res?.rows?.[0] as { file_id: string } | undefined)?.file_id ?? null;
  if (aliasCache.size > ALIAS_CACHE_MAX) {
    const oldest = aliasCache.keys().next().value;
    if (oldest) aliasCache.delete(oldest);
  }
  aliasCache.set(aliasPath, { fileId, at: Date.now() });
  return fileId;
}

/**
 * Insert alias keys for a file under `folderChain` + `name`: the bare name and
 * the name under every folder-prefix (all folder segments lowercased — the
 * public URL is case-tolerant for folders). Keys end in the exact filename.
 */
async function insertAliasKeys(fileId: string, folderChain: string[], name: string): Promise<void> {
  const keys: string[] = [aliasKeyFor([], name)];
  let acc: string[] = [];
  for (const seg of folderChain) {
    acc = [...acc, seg.toLowerCase()];
    keys.push([...acc, name].join('/'));
  }
  for (const key of keys) {
    aliasCache.delete(key); // a stale negative lookup must not shadow it
    await q(
      `INSERT INTO cdn_path_aliases (alias_path, file_id) VALUES ($1, $2) ON CONFLICT (alias_path) DO NOTHING`,
      [key, fileId],
    ).catch(() => {});
  }
}

/**
 * Snapshot a file's CURRENT live path (bare name + every folder prefix) so
 * future renames/moves anywhere in its chain can't orphan existing links.
 * Best-effort — live resolution still works without it.
 */
async function recordPathAliases(fileId: string): Promise<void> {
  try {
    const paths = await buildPathMap();
    const own = paths.get(fileId);
    if (!own || own.length === 0) return;
    await insertAliasKeys(fileId, own.slice(0, -1).map((s) => s.toLowerCase()), own[own.length - 1]);
  } catch {
    // best-effort
  }
}

/** Walk a folder path (e.g. ["Tirbeo","Design"]) to its folder row. */
export async function getFolderByPath(path: string[]): Promise<{ id: string; filename: string } | null> {
  if (path.length === 0) return null;
  let parent: string | null = null;
  let current: { id: string; filename: string } | null = null;
  for (const segment of path) {
    const row = await findFolderByName(parent, segment);
    if (!row) return null;
    current = { id: row.id, filename: segment };
    parent = row.id;
  }
  return current;
}

/**
 * Ensure every folder in `segments` exists (creating missing ones via the
 * regular folder upload path), then return the id of the deepest one.
 * Used by the v1 path API so `path: "a/b/c"` addresses real nested folder
 * rows — never slash-joined flat filenames.
 */
export async function ensureFolderChain(userId: string, segments: string[]): Promise<string | null> {
  if (!segments.length) return null;
  let parentId: string | null = null;
  for (const raw of segments) {
    const name = raw.trim().replace(/\/+$/, '');
    if (!name || name === '.' || name === '..' || name.includes('/')) {
      const e: any = new Error(`Invalid folder segment: ${raw}`); e.statusCode = 400; throw e;
    }
    const existing = await findFolderByName(parentId, name);
    if (existing) {
      parentId = existing.id;
      continue;
    }
    // Folder-marker rows carry no bytes; filename is the segment name only.
    const dto = await uploadCdnFile({
      userId,
      filename: name,
      contentType: 'application/x-tirbeo-folder',
      bytes: Buffer.alloc(0),
      folder: true,
      parentId,
    });
    parentId = dto.id;
  }
  return parentId;
}

// ─── Upload (company file — owner attribution, actor-logged) ───

export async function uploadCdnFile(input: {
  userId: string; // actor/uploader
  filename: string;
  contentType: string;
  bytes: Buffer;
  folder?: boolean; // create a folder row instead of a file
  parentId?: string | null; // parent folder id (nested folders)
  owner?: { id: string; name: string | null; email: string | null };
  visibility?: 'public' | 'private'; // default public (embed anywhere, no login)
}): Promise<CdnFileDto> {
  if (!input.folder && (!input.bytes || input.bytes.length === 0)) {
    const e: any = new Error('File is empty'); e.statusCode = 400; throw e;
  }
  if (input.bytes && input.bytes.length > MAX_UPLOAD_BYTES) {
    const e: any = new Error(`File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit.`); e.statusCode = 413; throw e;
  }
  // Storage is unlimited — no org-wide quota check.

  const filename = (input.filename || (input.folder ? 'Untitled folder' : 'untitled')).slice(0, 255);

  // Guard against duplicate folder names in the same parent.
  if (input.folder) {
    const dup = await findFolderByName(input.parentId ?? null, filename);
    if (dup) {
      const e: any = new Error(`A folder named “${filename}” already exists here.`); e.statusCode = 409; throw e;
    }
  }

  const id = randomUUID();
  const uploader = input.owner ?? { id: input.userId, name: null, email: null };
  const s3Key = `files/${uploader.id}/${id}-${filename.replace(/[^a-zA-Z0-9._\-/]/g, '_')}`;

  await q(
    `INSERT INTO cdn_files (id, user_id, owner_id, owner_name, owner_email, filename, s3_key, mime_type, size, content, folder, parent_id, visibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      input.userId,
      uploader.id,
      uploader.name,
      uploader.email,
      filename,
      s3Key,
      input.folder ? 'application/x-tirbeo-folder' : input.contentType || 'application/octet-stream',
      input.bytes?.length ?? 0,
      input.folder ? Buffer.alloc(0) : input.bytes,
      !!input.folder,
      input.parentId ?? null,
      input.visibility === 'private' ? 'private' : 'public',
    ],
    /* ensure */ true,
  );
  invalidatePathMap();

  // ── AUTO-WARM: small public uploads land in the edge cache immediately —
  // profile pics / media are served from memory on the very first /u/ hit,
  // no manual warm needed. Zero extra I/O: the bytes are already in hand. ──
  if (!input.folder && input.visibility !== 'private') {
    warmBytesDirect(id, input.bytes, input.contentType, filename);
  }

  const created = await getCdnFileMeta(id);
  logCdnActivity({
    userId: input.userId,
    type: input.folder ? 'cdn.folder.create' : 'cdn.file.upload',
    fileId: id,
    filename,
    metadata: {
      size: input.bytes?.length ?? 0,
      mimeType: input.folder ? 'application/x-tirbeo-folder' : input.contentType || 'application/octet-stream',
      ownerId: uploader.id,
      ownerName: uploader.name,
      parentId: input.parentId ?? null,
      scope: 'company',
    },
  }).catch(() => {});
  publishCdnEvent({
    type: input.folder ? 'cdn.file.create_folder' : 'cdn.file.upload',
    fileId: id,
    actorId: input.userId,
    file: created as any,
    filename,
  }).catch(() => {});
  return created;
}

// ─── Reads (company-wide — every privileged user sees every file) ───

export async function getCdnFileMeta(fileId: string): Promise<CdnFileDto> {
  const res = await q(
    `SELECT ${LIST_COLUMNS} FROM cdn_files WHERE id = $1`,
    [fileId],
  );
  if (res.rows.length === 0) {
    const e: any = new Error('File not found'); e.statusCode = 404; throw e;
  }
  const [dto] = await attachOwnerPhotos([rowToDto(res.rows[0] as CdnFileRow, await buildPathMap())]);
  return dto;
}

export async function listCdnFiles(opts: { includeDeleted?: boolean } = {}): Promise<CdnFileDto[]> {
  await ensureCockroachSchema();
  const res = await q(
    `SELECT ${LIST_COLUMNS} FROM cdn_files WHERE deleted = $1 ORDER BY created_at DESC`,
    [opts.includeDeleted ? true : false],
  );
  const paths = await buildPathMap();
  return (res.rows as CdnFileRow[]).map((r) => rowToDto(r, paths));
}

/** All company files in ONE round trip, split into active + trash. */
export async function listAllCdnFiles(): Promise<{ active: CdnFileDto[]; trash: CdnFileDto[] }> {
  await ensureCockroachSchema();
  const res = await q(
    `SELECT ${LIST_COLUMNS} FROM cdn_files ORDER BY created_at DESC`,
  );
  const paths = await buildPathMap();
  const active: CdnFileDto[] = [];
  const trash: CdnFileDto[] = [];
  for (const row of res.rows as CdnFileRow[]) {
    ((row.deleted ? trash : active) as CdnFileDto[]).push(rowToDto(row, paths));
  }
  await attachOwnerPhotos([...active, ...trash]);
  return { active, trash };
}

/** Direct children (files + folders) of one folder — for folder pages. */
export async function listCdnChildren(
  folderId: string | null,
): Promise<{ folders: CdnFileDto[]; files: CdnFileDto[] }> {
  await ensureCockroachSchema();
  const res = await q(
    `SELECT ${LIST_COLUMNS} FROM cdn_files
     WHERE deleted = false AND ${folderId ? 'parent_id = $1' : '(parent_id IS NULL)'}
     ORDER BY created_at DESC`,
    folderId ? [folderId] : [],
  );
  const paths = await buildPathMap();
  const folders: CdnFileDto[] = [];
  const files: CdnFileDto[] = [];
  for (const row of res.rows as CdnFileRow[]) {
    ((row.folder ? folders : files) as CdnFileDto[]).push(rowToDto(row, paths));
  }
  return { folders, files };
}

export async function getCdnFileBytes(fileId: string): Promise<{ dto: CdnFileDto; bytes: Buffer }> {
  const res = await q(
    `SELECT ${LIST_COLUMNS}, content FROM cdn_files WHERE id = $1`,
    [fileId],
  );
  if (res.rows.length === 0) {
    const e: any = new Error('File not found'); e.statusCode = 404; throw e;
  }
  const row = res.rows[0] as CdnFileRow;
  return { dto: rowToDto(row), bytes: row.content };
}

export async function getCdnFileBytesByKey(s3Key: string): Promise<{ dto: CdnFileDto; bytes: Buffer } | null> {
  const res = await q(
    `SELECT ${LIST_COLUMNS}, content FROM cdn_files WHERE s3_key = $1`,
    [s3Key],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as CdnFileRow;
  return { dto: rowToDto(row), bytes: row.content };
}

// ─── Mutations (company-wide — any privileged user may edit; actor logged) ───

export async function renameCdnFile(actorId: string, fileId: string, newFilename: string): Promise<CdnFileDto> {
  const finalName = (newFilename || '').trim().slice(0, 255);
  if (!finalName) {
    const e: any = new Error('Please enter a valid file name.'); e.statusCode = 400; throw e;
  }
  // Capture the pre-rename identity so existing /u/a/... links keep working.
  const pre = await q(`SELECT filename, folder FROM cdn_files WHERE id = $1 AND deleted = false`, [fileId]);
  const preRow = pre.rows[0] as { filename: string; folder: boolean } | undefined;
  const res = await q(
    `UPDATE cdn_files SET filename = $2, updated_at = now() WHERE id = $1 AND deleted = false RETURNING ${LIST_COLUMNS}`,
    [fileId, finalName],
  );
  if (res.rows.length === 0) {
    const e: any = new Error('File not found'); e.statusCode = 404; throw e;
  }
  invalidatePathMap();
  const paths = await buildPathMap();
  const [dto] = await attachOwnerPhotos([rowToDto(res.rows[0] as CdnFileRow, paths)]);
  // ── Alias the OLD name → this file (and descendants' old chains for folders)
  // so /u/a/Images/x.png keeps resolving after Images → images / Pictures. ──
  const newPath = paths.get(fileId);
  if (preRow && preRow.filename !== finalName && newPath && newPath.length > 0) {
    const depth = newPath.length - 1;
    try {
      await insertAliasKeys(fileId, newPath.slice(0, -1).map((s) => s.toLowerCase()), preRow.filename);
      if (preRow.folder) {
        for (const [id, p] of paths) {
          if (id === fileId || p.length <= depth + 1 || p[depth] !== finalName) continue;
          const oldChain = [...p.slice(0, depth), preRow.filename, ...p.slice(depth + 1)];
          await insertAliasKeys(id, oldChain.slice(0, -1).map((s) => s.toLowerCase()), oldChain[oldChain.length - 1]);
        }
      }
    } catch {
      // best-effort
    }
  }
  logCdnActivity({ userId: actorId, type: 'cdn.file.rename', fileId, filename: finalName }).catch(() => {});
  publishCdnEvent({ type: 'cdn.file.rename', fileId, actorId, file: dto as any, filename: finalName }).catch(() => {});
  return dto;
}

export async function setCdnFileStarred(actorId: string, fileId: string, starred: boolean): Promise<CdnFileDto> {
  const res = await q(
    `UPDATE cdn_files SET starred = $2, updated_at = now() WHERE id = $1 RETURNING ${LIST_COLUMNS}`,
    [fileId, starred],
  );
  if (res.rows.length === 0) {
    const e: any = new Error('File not found'); e.statusCode = 404; throw e;
  }
  const [dto] = await attachOwnerPhotos([rowToDto(res.rows[0] as CdnFileRow, await buildPathMap())]);
  logCdnActivity({ userId: actorId, type: starred ? 'cdn.file.star' : 'cdn.file.unstar', fileId }).catch(() => {});
  publishCdnEvent({ type: starred ? 'cdn.file.star' : 'cdn.file.unstar', fileId, actorId, file: dto as any }).catch(() => {});
  return dto;
}

/**
 * Flip a file's visibility: 'public' (served from /u/... with NO login or
 * signature) or 'private' (only fetchable via a valid signed URL). The path
 * cache is invalidated so the public delivery endpoint never serves a stale
 * visibility state.
 */
export async function setCdnFileVisibility(
  actorId: string,
  fileId: string,
  visibility: 'public' | 'private',
): Promise<CdnFileDto> {
  const value = visibility === 'private' ? 'private' : 'public';
  const res = await q(
    `UPDATE cdn_files SET visibility = $2, updated_at = now() WHERE id = $1 AND deleted = false RETURNING ${LIST_COLUMNS}`,
    [fileId, value],
  );
  if (res.rows.length === 0) {
    const e: any = new Error('File not found'); e.statusCode = 404; throw e;
  }
  invalidatePathMap();
  // Cache coherence: a private file must never serve from a warm cache, and
  // a newly-public one may start warming. Visibility was set in the UPDATE.
  if (value === 'private') dropPrewarmed(fileId);
  const [dto] = await attachOwnerPhotos([rowToDto(res.rows[0] as CdnFileRow, await buildPathMap())]);
  if (value === 'public' && dto.size > 0 && dto.size <= AUTO_WARM_MAX_BYTES) {
    // Newly-public small file — pull its bytes once and warm (fire-and-forget).
    void getCdnFileBytes(fileId)
      .then(({ bytes }) => warmBytesDirect(fileId, bytes, dto.contentType, dto.filename))
      .catch(() => {});
  }
  logCdnActivity({
    userId: actorId,
    type: value === 'private' ? 'cdn.file.make_private' : 'cdn.file.make_public',
    fileId,
    metadata: { visibility: value },
  }).catch(() => {});
  publishCdnEvent({ type: value === 'private' ? 'cdn.file.make_private' : 'cdn.file.make_public', fileId, actorId, file: dto as any }).catch(() => {});
  return dto;
}

export async function setSelfDestruct(actorId: string, fileId: string, expiresAtMs: number | null): Promise<void> {
  // Table is created by ensureCockroachSchema() — no per-request DDL.
  await ensureCockroachSchema();
  if (expiresAtMs == null) {
    await q(`DELETE FROM cdn_self_destruct WHERE file_id = $1`, [fileId]);
    logCdnActivity({ userId: actorId, type: 'cdn.file.self_destruct_cleared', fileId }).catch(() => {});
    return;
  }
  const safe = Math.min(Math.max(expiresAtMs, Date.now()), Date.now() + SELF_DESTRUCT_MAX_MS);
  await q(
    `INSERT INTO cdn_self_destruct (file_id, user_id, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (file_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [fileId, actorId, new Date(safe)],
  );
  logCdnActivity({ userId: actorId, type: 'cdn.file.self_destruct_set', fileId, metadata: { expiresAt: safe } }).catch(() => {});
}

/** Attach self-destruct expiry info onto dtos (merged after listing). */
export async function attachSelfDestruct(dtos: CdnFileDto[]): Promise<CdnFileDto[]> {
  if (dtos.length === 0) return dtos;
  const res = await q(
    `SELECT file_id, EXTRACT(epoch FROM expires_at)::INT8 * 1000 AS expires_ms FROM cdn_self_destruct`,
  ).catch(() => ({ rows: [] as any[] }));
  const map = new Map<string, number>();
  for (const r of (res as any).rows) map.set(r.file_id, Number(r.expires_ms));
  return dtos.map((d) => ({ ...d, selfDestructAt: map.get(d.id) ?? null }));
}

export async function moveToTrash(actorId: string, fileId: string): Promise<CdnFileDto> {
  const res = await q(
    `UPDATE cdn_files SET deleted = true, updated_at = now() WHERE id = $1 AND deleted = false RETURNING ${LIST_COLUMNS}`,
    [fileId],
  );
  if (res.rows.length === 0) {
    const e: any = new Error('File not found'); e.statusCode = 404; throw e;
  }
  invalidatePathMap();
  const [dto] = await attachOwnerPhotos([rowToDto(res.rows[0] as CdnFileRow, await buildPathMap())]);
  logCdnActivity({ userId: actorId, type: 'cdn.file.trash', fileId }).catch(() => {});
  publishCdnEvent({ type: 'cdn.file.trash', fileId, actorId, file: dto as any }).catch(() => {});
  return dto;
}

/**
 * Move a file/folder into another folder (or the workspace root). Realtime +
 * logged. Guards against dropping a folder into itself or a descendant.
 */
export async function moveCdnFile(actorId: string, fileId: string, newParentId: string | null): Promise<CdnFileDto> {
  const res = await q(
    `SELECT id, folder, parent_id FROM cdn_files WHERE id = $1 AND deleted = false`,
    [fileId],
  );
  if (res.rows.length === 0) {
    const e: any = new Error('File not found'); e.statusCode = 404; throw e;
  }
  const row = res.rows[0] as { id: string; folder: boolean; parent_id: string | null };
  if ((row.parent_id ?? null) === (newParentId ?? null)) {
    // No-op move — return current state without an update.
    return getCdnFileMeta(fileId);
  }
  if (row.folder && newParentId) {
    // Walk up from the target parent; if we meet the moved folder, it's a cycle.
    let cursor: string | null = newParentId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      if (cursor === fileId) {
        const e: any = new Error("A folder can't be moved into itself or one of its subfolders.");
        e.statusCode = 400; throw e;
      }
      seen.add(cursor);
      const parent = await q(`SELECT parent_id FROM cdn_files WHERE id = $1`, [cursor]);
      cursor = (parent.rows[0] as { parent_id: string | null } | undefined)?.parent_id ?? null;
    }
  }
  if (newParentId) {
    const target = await q(`SELECT id FROM cdn_files WHERE id = $1 AND folder = true AND deleted = false`, [newParentId]);
    if (target.rows.length === 0) {
      const e: any = new Error('Destination folder not found'); e.statusCode = 404; throw e;
    }
  }
  // Snapshot the OLD location chains (this item + descendants) BEFORE the
  // parent changes, so existing /u/a/... links keep resolving afterwards.
  const oldPaths = await buildPathMap();
  const ownOld = oldPaths.get(fileId);
  const descendantIds: string[] = [];
  if (row.folder && ownOld) {
    for (const [id, p] of oldPaths) {
      if (id !== fileId && ownOld.length > 0 && p.length > ownOld.length &&
          ownOld.every((seg, i) => p[i] === seg)) {
        descendantIds.push(id);
      }
    }
  }

  const upd = await q(
    `UPDATE cdn_files SET parent_id = $2, updated_at = now() WHERE id = $1 RETURNING ${LIST_COLUMNS}`,
    [fileId, newParentId],
  );
  invalidatePathMap();
  const [dto] = await attachOwnerPhotos([rowToDto(upd.rows[0] as CdnFileRow, await buildPathMap())]);
  // Old-location links keep working: alias the pre-move chain of the moved
  // item and every descendant that lived under it.
  try {
    if (ownOld && ownOld.length > 0) {
      await insertAliasKeys(fileId, ownOld.slice(0, -1).map((s) => s.toLowerCase()), ownOld[ownOld.length - 1]);
      for (const did of descendantIds) {
        const dp = oldPaths.get(did);
        if (dp && dp.length > 0) {
          await insertAliasKeys(did, dp.slice(0, -1).map((s) => s.toLowerCase()), dp[dp.length - 1]);
        }
      }
    }
  } catch {
    // best-effort
  }
  logCdnActivity({ userId: actorId, type: 'cdn.file.move', fileId, filename: dto.filename, metadata: { parentId: newParentId, scope: 'company' } }).catch(() => {});
  publishCdnEvent({ type: 'cdn.file.move', fileId, actorId, file: dto as any, filename: dto.filename }).catch(() => {});
  return dto;
}

export async function restoreFromTrash(actorId: string, fileId: string): Promise<CdnFileDto> {
  const res = await q(
    `UPDATE cdn_files SET deleted = false, updated_at = now() WHERE id = $1 AND deleted = true RETURNING ${LIST_COLUMNS}`,
    [fileId],
  );
  if (res.rows.length === 0) {
    const e: any = new Error('File not found in trash'); e.statusCode = 404; throw e;
  }
  invalidatePathMap();
  const [dto] = await attachOwnerPhotos([rowToDto(res.rows[0] as CdnFileRow, await buildPathMap())]);
  logCdnActivity({ userId: actorId, type: 'cdn.file.restore', fileId }).catch(() => {});
  publishCdnEvent({ type: 'cdn.file.restore', fileId, actorId, file: dto as any }).catch(() => {});
  return dto;
}

export async function permanentlyDeleteCdnFile(actorId: string, fileId: string): Promise<void> {
  const res = await q(
    `DELETE FROM cdn_files WHERE id = $1`,
    [fileId],
  );
  if ((res.rowCount ?? 0) === 0) {
    const e: any = new Error('File not found'); e.statusCode = 404; throw e;
  }
  await q(`DELETE FROM cdn_self_destruct WHERE file_id = $1`, [fileId]).catch(() => {});
  await q(`DELETE FROM cdn_path_aliases WHERE file_id = $1`, [fileId]).catch(() => {});
  invalidatePathMap();
  // Drop any cached sharp derivative so a re-uploaded id can never serve stale bytes.
  invalidateThumbCache(fileId);
  // And drop any pre-warmed public bytes so a deleted file can't leak from cache.
  dropPrewarmed(fileId);
  logCdnActivity({ userId: actorId, type: 'cdn.file.delete_permanent', fileId }).catch(() => {});
  publishCdnEvent({ type: 'cdn.file.delete_permanent', fileId, actorId }).catch(() => {});
}

// ─── Mark opened (rate-limited by client) ───

export async function markCdnFileOpened(actorId: string, fileId: string): Promise<void> {
  await q(
    `UPDATE cdn_files SET last_opened_at = now() WHERE id = $1`,
    [fileId],
  ).catch(() => {});
  // Per-user open record — the backbone of both Recent feeds (me + org).
  await q(
    `INSERT INTO cdn_file_opens (file_id, user_id, opened_at) VALUES ($1, $2, now())
     ON CONFLICT (file_id, user_id) DO UPDATE SET opened_at = now()`,
    [fileId, actorId],
  ).catch(() => {});
  logCdnActivity({ userId: actorId, type: 'cdn.file.opened', fileId }).catch(() => {});
  publishCdnEvent({ type: 'cdn.file.opened', fileId, actorId }).catch(() => {});
}

// ─── Recent feeds (sidebar = per user; Home = whole organization) ───

export interface RecentEntry {
  file: CdnFileDto;
  /** Who last opened it (null when the row IS the viewer). */
  openedBy: string | null;
  openedByName: string | null;
  openedAt: number;
  /** "opened" | "created" | "uploaded" | "edited" — why it's suggested. */
  reason: string;
}

/**
 * Per-user recents (sidebar): everything THIS member last opened, newest first.
 */
export async function listMyRecentFiles(userId: string, limit = 40): Promise<RecentEntry[]> {
  await ensureCockroachSchema();
  const res = await q(
    `SELECT o.file_id, o.opened_at, ${LIST_COLUMNS_F}
     FROM cdn_file_opens o
     JOIN cdn_files f ON f.id = o.file_id
     WHERE o.user_id = $1 AND f.deleted = false
     ORDER BY o.opened_at DESC
     LIMIT $2`,
    [userId, Math.min(limit, 100)],
  );
  const paths = await buildPathMap();
  const dtos = res.rows.map((r: any) => rowToDto(r as CdnFileRow, paths));
  await attachOwnerPhotos(dtos);
  return res.rows.map((r: any, i: number) => ({
    file: dtos[i],
    openedBy: null, // the viewer themselves
    openedByName: null,
    openedAt: toMillis(r.opened_at) ?? Date.now(),
    reason: 'opened',
  }));
}

/**
 * Organization-wide recents (Home): the whole company's latest opens,
 * uploads, and creations merged into one time-ordered feed — Drive-style.
 * Each entry carries WHO did it and WHAT they did so the UI can render
 * "Sara opened • 11:35 PM" / "You uploaded • Aug 18".
 */
export async function listOrgRecentFiles(viewerId: string, limit = 60): Promise<RecentEntry[]> {
  await ensureCockroachSchema();
  const cap = Math.min(limit, 150);
  type Row = {
    file_id: string;
    actor_id: string;
    activity: string;
    at: CrdbTimestamp;
    [k: string]: any;
  };
  const res = await q<
    { rows: Row[] }
  >(
    `(
       SELECT o.file_id, o.user_id AS actor_id, 'opened' AS activity, o.opened_at AS at, ${LIST_COLUMNS_F}
       FROM cdn_file_opens o JOIN cdn_files f ON f.id = o.file_id
       WHERE f.deleted = false
     )
     UNION ALL
     (
       SELECT f.id AS file_id, f.owner_id AS actor_id,
              CASE WHEN f.folder THEN 'created' ELSE 'uploaded' END AS activity,
              f.created_at AS at, ${LIST_COLUMNS_F}
       FROM cdn_files f
       WHERE f.deleted = false
     )
     ORDER BY at DESC
     LIMIT $1`,
    [cap],
  );
  const paths = await buildPathMap();
  const dtos = res.rows.map((r) => rowToDto(r as unknown as CdnFileRow, paths));
  await attachOwnerPhotos(dtos);
  // Actor display names — one batched lookup for all distinct actors.
  const actorIds = [...new Set(res.rows.map((r) => r.actor_id).filter(Boolean))];
  const actorNames = new Map<string, string | null>();
  if (actorIds.length > 0) {
    try {
      const users = await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      });
      for (const u of users) actorNames.set(u.id, u.name || u.email.split('@')[0]);
    } catch {
      // names stay null
    }
  }
  return res.rows.map((r, i) => ({
    file: dtos[i],
    openedBy: r.actor_id || null,
    openedByName: actorNames.get(r.actor_id) ?? null,
    openedAt: toMillis(r.at) ?? Date.now(),
    reason: r.activity,
  }));
}

// ─── Trash purge (cron + on-demand) ───

const TRASH_CUTOFF = () => new Date(Date.now() - TRASH_RETENTION_MS);

export async function purgeExpiredTrash(): Promise<number> {
  // Collect ids BEFORE the delete so we can evict their thumbnail derivatives.
  const doomed = await q(
    `SELECT id FROM cdn_files WHERE deleted = true AND updated_at < $1`,
    [TRASH_CUTOFF()],
  );
  const res = await q(
    `DELETE FROM cdn_files WHERE deleted = true AND updated_at < $1`,
    [TRASH_CUTOFF()],
  );
  if ((res.rowCount ?? 0) > 0) {
    for (const row of doomed.rows) invalidateThumbCache(row.id);
    console.log(`[CDN-PURGE] Removed ${res.rowCount} expired trash files`);
  }
  return res.rowCount ?? 0;
}

export async function purgeAllExpiredTrash(): Promise<number> {
  return purgeExpiredTrash();
}

/** Self-destruct sweep: trashes (then the trash purge handles bytes) expired files. */
export async function selfDestructSweep(): Promise<number> {
  await ensureCockroachSchema();
  const res = await q(
    `UPDATE cdn_files f SET deleted = true, updated_at = now()
     FROM cdn_self_destruct sd
     WHERE sd.file_id = f.id
       AND f.deleted = false AND sd.expires_at <= now()`,
  );
  const trashed = res.rowCount ?? 0;
  if (trashed > 0) {
    await q(`DELETE FROM cdn_self_destruct WHERE expires_at <= now()`).catch(() => {});
    console.log(`[CDN-SELFDESTRUCT] Trashed ${trashed} expired files`);
  }
  return trashed;
}

// ═══ SHARE LINKS (one-time, stored in CockroachDB, realtime events) ═══

export interface ShareLinkResult {
  token: string;
  url: string;
  filename: string;
}

export async function createShareLink(input: {
  userId: string; // actor
  fileId: string;
  origin: string;
  /** Optional link expiry (epoch ms). Undefined/null = never expires. */
  expiresAt?: number | null;
}): Promise<ShareLinkResult> {
  const file = await getCdnFileMeta(input.fileId);
  const token = Buffer.from(randomBytes(24)).toString('hex');
  const expiresAt =
    typeof input.expiresAt === 'number' && input.expiresAt > Date.now()
      ? new Date(Math.min(input.expiresAt, Date.now() + 30 * 86_400_000)) // cap 30 days
      : null;

  await q(
    `INSERT INTO cdn_share_links (token, user_id, file_id, filename, mime_type, size, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [token, input.userId, input.fileId, file.filename, file.contentType, file.size, expiresAt],
    /* ensure */ true,
  );

  const baseOrigin = (input.origin || '').replace(/\/$/, '');
  logCdnActivity({
    userId: input.userId,
    type: 'cdn.file.share_link',
    fileId: input.fileId,
    filename: file.filename,
  }).catch(() => {});
  // Realtime: share activity shows up instantly everywhere (feed + toasts).
  publishCdnEvent({
    type: 'cdn.file.share_link',
    fileId: input.fileId,
    actorId: input.userId,
    filename: file.filename,
    metadata: { size: file.size, contentType: file.contentType },
  }).catch(() => {});
  return { token, url: `${baseOrigin}/share/${token}`, filename: file.filename };
}

export interface RedeemedShare {
  token: string;
  filename: string;
  contentType: string;
  size: number;
  contentUrl: string;
  /** Epoch ms when the redeemed content URL stops serving (null = no limit). */
  contentExpiresAt: number | null;
}

/** True when a link record's TTL has passed. */
function isShareExpired(expiresAt: Date | string | null | undefined): boolean {
  if (!expiresAt) return false;
  const t = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  return Number.isFinite(t) && t <= Date.now();
}

/**
 * Atomically redeem a one-time link (destructive — flips the redeemed flag).
 * Returns null when missing/used/expired. Only the explicit POST redeem calls
 * this. The redeemed content URL stays usable for CONTENT_ACCESS_WINDOW_MS
 * (just long enough to view/download), then dies with the link.
 */
export const CONTENT_ACCESS_WINDOW_MS = 15 * 60_000;

export async function redeemShareLink(token: string, baseUrl = ''): Promise<RedeemedShare | null> {
  if (!token || token.length < 16) return null;
  const res = await q(
    `UPDATE cdn_share_links SET redeemed = true, redeemed_at = now(),
       content_expires_at = now() + INTERVAL '${Math.round(CONTENT_ACCESS_WINDOW_MS / 1000)} seconds'
     WHERE token = $1 AND redeemed = false AND (expires_at IS NULL OR expires_at > now())
     RETURNING filename, mime_type, size, file_id, user_id AS creator_id, content_expires_at`,
    [token],
    /* ensure */ true,
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  const base = (baseUrl || '').replace(/\/$/, '');
  logCdnActivity({
    userId: 'anonymous',
    type: 'cdn.share.redeemed',
    fileId: row.file_id ?? null,
    filename: row.filename,
    metadata: { token },
  }).catch(() => {});
  // One shared timestamp: the broadcast event and the targeted alert carry
  // the same `at`, so client-side dedupe keys always match.
  const redeemedAt = Date.now();
  publishCdnEvent({
    type: 'cdn.share.redeemed',
    fileId: row.file_id ?? '',
    actorId: 'anonymous',
    filename: row.filename,
    metadata: { creatorId: row.creator_id ?? null, token },
    at: redeemedAt,
  }).catch(() => {});
  // Creator alert: push an "your link was opened" frame to the OWNER's
  // user:<id> WebSocket channel (auth-gated), fire-and-forget.
  alertCreatorShareRedeemed({
    creatorId: row.creator_id ?? null,
    fileId: row.file_id ?? '',
    filename: row.filename,
    token,
    at: redeemedAt,
  });
  return {
    token,
    filename: row.filename,
    contentType: row.mime_type,
    size: Number(row.size),
    // Clean, copy-anywhere public URL — serves the bytes until the access
    // window closes, then dies with the link.
    contentUrl: `${base}/share-file/${token}`,
    contentExpiresAt: row.content_expires_at ? new Date(row.content_expires_at).getTime() : null,
  };
}

/**
 * NON-destructive one-time link check: reports validity + metadata WITHOUT
 * redeeming. Used by GET so link previews, prefetches, and scanners can
 * never burn the recipient's single open.
 */
export async function peekShareLink(token: string, baseUrl = ''): Promise<RedeemedShare | null> {
  const record = await getShareLinkRecord(token);
  if (!record) return null;
  if (record.expiresAt && record.expiresAt <= Date.now()) return null; // expired
  const base = (baseUrl || '').replace(/\/$/, '');
  return {
    token,
    filename: record.filename,
    contentType: record.mimeType,
    size: record.size,
    contentUrl: `${base}/api/cdn/share/${token}/content`,
    contentExpiresAt: null, // window only starts at redeem
  };
}

export interface ShareRecord {
  token: string;
  userId: string;
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  redeemed: boolean;
  /** Epoch ms when the link stops being redeemable (null = never). */
  expiresAt: number | null;
}

export async function getShareLinkRecord(token: string): Promise<ShareRecord | null> {
  if (!token || token.length < 16) return null;
  const res = await q(
    `SELECT token, user_id, file_id, filename, mime_type, size, redeemed, expires_at FROM cdn_share_links WHERE token = $1`,
    [token],
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    token: r.token,
    userId: r.user_id,
    fileId: r.file_id,
    filename: r.filename,
    mimeType: r.mime_type,
    size: Number(r.size),
    redeemed: !!r.redeemed,
    expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
  };
}

/**
 * Delete expired, never-redeemed links (their tokens are dead anyway).
 * Part of the cdn_purge job; redeemed links are kept for the audit trail.
 */
export async function purgeExpiredShareLinks(): Promise<number> {
  try {
    const res = await q(`DELETE FROM cdn_share_links WHERE expires_at IS NOT NULL AND expires_at <= now()`);
    if ((res.rowCount ?? 0) > 0) console.log(`[CDN-SHARE] Purged ${res.rowCount} expired share links`);
    return res.rowCount ?? 0;
  } catch {
    return 0;
  }
}

/** Bytes for an already-redeemed link — single joined query, no second hop. */
// Redeemed share content is immutable (one-time link → fixed file), so a
// short in-process cache turns repeated loads into instant responses.
// Entries respect the link's expiry: expired tokens never serve from cache.
const shareContentCache = new Map<
  string,
  { bytes: Buffer; mimeType: string; filename: string; at: number; expiresAt: number | null }
>();
const SHARE_CONTENT_TTL_MS = 10 * 60_000;
const SHARE_CONTENT_MAX = 100;

export async function getShareContentBytes(
  token: string,
): Promise<{ bytes: Buffer; mimeType: string; filename: string; expiresAt: number | null } | null> {
  if (!token || token.length < 16) return null;
  const hit = shareContentCache.get(token);
  if (hit && Date.now() - hit.at < SHARE_CONTENT_TTL_MS) {
    if (hit.expiresAt !== null && hit.expiresAt <= Date.now()) return null; // window over
    return hit;
  }
  const res = await q(
    `SELECT f.content, f.mime_type, f.filename, s.expires_at, s.content_expires_at
     FROM cdn_share_links s JOIN cdn_files f ON f.id = s.file_id
     WHERE s.token = $1 AND s.redeemed = true`,
    [token],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  const expiresAt = row.content_expires_at
    ? new Date(row.content_expires_at).getTime()
    : row.expires_at
      ? new Date(row.expires_at).getTime()
      : null;
  if (expiresAt !== null && expiresAt <= Date.now()) return null; // window over
  const value = {
    bytes: row.content as Buffer,
    mimeType: row.mime_type as string,
    filename: row.filename as string,
    expiresAt,
  };
  if (shareContentCache.size >= SHARE_CONTENT_MAX) {
    const oldest = shareContentCache.keys().next().value;
    if (oldest) shareContentCache.delete(oldest);
  }
  shareContentCache.set(token, { ...value, at: Date.now() });
  return value;
}

// ═══ USER ENRICHMENT (Supabase — profiles/identities) ═══

export interface CdnUserSummary {
  id: string;
  name: string | null;
  email: string;
  photoUrl: string | null;
}

/**
 * Member summary. Identity lives on the API's own DB (Supabase Postgres
 * via Prisma) — the same place accounts/dashboard read it from.
 */
export async function getCdnUserSummary(userId: string): Promise<CdnUserSummary | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, photoUrl: true },
    });
    return user ?? null;
  } catch {
    return null;
  }
}

/** Simple LRU-ish memo for path lookups — long TTL (15 min) so hot public
 *  URLs answer in ms; any mutation clears it via invalidatePathMap() so
 *  renames/moves are reflected instantly. */
const pathCache = new Map<string, { bytes: Buffer; mimeType: string | null; filename: string; fileId: string; visibility: 'public' | 'private'; at: number }>();
const PATH_CACHE_TTL_MS = 15 * 60_000;
const PATH_CACHE_MAX = 1000;

/**
 * Resolve a public path URL: ["a", "<folder1>", ..., "<filename.ext>"].
 * The first segment is the fixed org alias "a" (kept for back-compat: an
 * ownerId also works). The last segment is the filename; everything between
 * is the folder chain, resolved by walking real folder rows — so nested
 * folders of any depth work, and renames invalidate naturally via the cache.
 */
export async function getFileByPublicPath(
  segments: string[],
): Promise<{ bytes: Buffer; mimeType: string | null; filename: string; fileId: string; visibility: 'public' | 'private' } | null> {
  if (!segments || segments.length < 2) return null;
  bindCrossInstanceInvalidation();
  const filename = segments[segments.length - 1];
  if (!filename || filename === '' || filename.includes('/')) return null;
  const folderPath = segments.slice(1, -1);
  const dec = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
  const cacheKey = ['a', ...folderPath.map(dec), dec(filename)].join('/');
  const cached = pathCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PATH_CACHE_TTL_MS) return cached;

  await ensureCockroachSchema();

  // ── 1) Metadata walk (no blob scans): one light query builds the id/parent
  // map (60s cache), then the chain resolves in-memory — measured in ms. ──
  const resolvedId = await resolvePathToFileId(folderPath, filename);
  if (resolvedId) return getFileBytesById(resolvedId, cacheKey);

  // ── 2) Alias table: one indexed PK lookup (plus casing variants). Renames
  // and moves record old paths here, so historical links — and any casing of
  // them — resolve instantly. ──
  for (const key of aliasKeysFor(folderPath, filename)) {
    const aliasedId = await lookupAlias(key);
    if (aliasedId) return getFileBytesById(aliasedId, cacheKey);
  }

  // ── 3) Last resort: per-segment DB walk (rare — covers rows whose aliases
  // weren't recorded yet, e.g. pre-migration files). ──
  let parentId: string | null = null;
  for (const rawSegment of folderPath) {
    const segment = dec(rawSegment);
    const folder = (await findFolderByName(parentId, segment)) ?? (await findFolderByNameCI(parentId, segment));
    if (!folder) return null;
    parentId = folder.id;
  }

  // The file row inside that folder — exact first, then case-insensitive.
  const name = dec(filename);
  let qres = await q(
    `SELECT id, content, mime_type, filename, visibility FROM cdn_files
     WHERE deleted = false AND folder = false AND filename = $1 AND ${parentId ? 'parent_id = $2' : '(parent_id IS NULL)'}
     ORDER BY created_at DESC
     LIMIT 1`,
    parentId ? [name, parentId] : [name],
  );
  if (qres.rows.length === 0) {
    qres = await q(
      `SELECT id, content, mime_type, filename, visibility FROM cdn_files
       WHERE deleted = false AND folder = false AND lower(filename) = lower($1) AND ${parentId ? 'parent_id = $2' : '(parent_id IS NULL)'}
       ORDER BY created_at DESC
       LIMIT 1`,
      parentId ? [name, parentId] : [name],
    );
  }
  if (qres.rows.length === 0) {
    return null;
  }
  const row = qres.rows[0];
  const bytes = Buffer.from(row.content);
  const entry = { bytes, mimeType: row.mime_type, filename: row.filename, fileId: row.id as string, visibility: (row.visibility === 'private' ? 'private' : 'public') as 'public' | 'private', at: Date.now() };
  pathCache.set(cacheKey, entry);
  if (pathCache.size > PATH_CACHE_MAX) {
    const oldest = [...pathCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) pathCache.delete(oldest[0]);
  }
  return { bytes: entry.bytes, mimeType: entry.mimeType, filename: entry.filename, fileId: entry.fileId, visibility: entry.visibility };
}

/**
 * FAST path for public delivery: resolve the path to a file id via the
 * metadata-only walk (never touches the blob-carrying `content` column),
 * then serve the control plane's PRE-WARMED bytes when this instance holds
 * them. Returns null when there is no warm hit — the caller falls back to
 * getFileByPublicPath. Private files are never served from pre-warm (the
 * caller's signature gate handles them).
 */
export async function getPrewarmedBytesByPublicPath(
  segments: string[],
): Promise<{ bytes: Buffer; mimeType: string | null; filename: string; fileId: string; visibility: 'public' | 'private' } | null> {
  if (!segments || segments.length < 2) return null;
  const filename = segments[segments.length - 1];
  if (!filename || filename === '' || filename.includes('/')) return null;
  const folderPath = segments.slice(1, -1);
  try {
    const resolvedId = await resolvePathToFileId(folderPath, filename);
    if (!resolvedId) return null;
    const warm = takePrewarmedBytes(resolvedId);
    if (!warm) return null;
    // Visibility guard: one tiny PK-indexed metadata read. A file flipped to
    // private must never keep streaming from a warm cache.
    const vis = await q(
      `SELECT visibility FROM cdn_files WHERE id = $1 AND deleted = false AND folder = false`,
      [resolvedId],
    );
    if (vis.rows.length === 0) return null;
    const visibility = (vis.rows[0] as { visibility: string | null }).visibility === 'private' ? 'private' : 'public';
    if (visibility === 'private') return null;
    return { bytes: warm.bytes, mimeType: warm.mimeType, filename: warm.filename, fileId: resolvedId, visibility };
  } catch {
    return null;
  }
}

/** Fetch a file's bytes by id — used when a path alias resolves. Result is
 *  seeded into the path cache under the requested alias key. */
async function getFileBytesById(
  fileId: string,
  cacheKey: string,
): Promise<{ bytes: Buffer; mimeType: string | null; filename: string; fileId: string; visibility: 'public' | 'private' } | null> {
  const res = await q(
    `SELECT id, content, mime_type, filename, visibility FROM cdn_files WHERE id = $1 AND deleted = false AND folder = false`,
    [fileId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  const bytes = Buffer.from(row.content);
  const entry = { bytes, mimeType: row.mime_type, filename: row.filename, fileId: row.id as string, visibility: (row.visibility === 'private' ? 'private' : 'public') as 'public' | 'private', at: Date.now() };
  pathCache.set(cacheKey, entry);
  return { bytes: entry.bytes, mimeType: entry.mimeType, filename: entry.filename, fileId: entry.fileId, visibility: entry.visibility };
}

/**
 * Build the canonical public URL path for a file: /u/a/<folder...>/<name>.
 * Folders are the file's real breadcrumb (path), "a" is the fixed org alias —
 * links stay stable no matter who copies them.
 */
/**
 * Canonical public URL path for a file id — /u/a/<current chain>/<name>.
 * Used for the self-healing `Link` header: old/aliased URLs advertise the
 * current URL so browsers and caches learn the canonical location.
 * Returns null when the file has no resolvable path (or is deleted).
 */
export async function getCanonicalPublicPath(fileId: string): Promise<string | null> {
  try {
    const paths = await buildPathMap();
    const p = paths.get(fileId);
    if (!p || p.length === 0) return null;
    return buildPublicPath({ path: p, filename: p[p.length - 1] });
  } catch {
    return null;
  }
}

export function buildPublicPath(file: { path?: string[]; filename: string }): string {
  const path = file.path && file.path.length > 0 ? file.path : [];
  const name = path.length > 0 ? path[path.length - 1] : file.filename;
  const folders = path.length > 1 ? path.slice(0, -1) : [];
  const encoded = [PUBLIC_OWNER_ALIAS, ...folders, name]
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `/u/${encoded}`;
}
