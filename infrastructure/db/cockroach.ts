import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

/**
 * CockroachDB connection pool for CDN file storage.
 *
 * CockroachDB is PostgreSQL wire-compatible, so the standard `pg` driver
 * works as-is. Connection string comes from COCKROACH_DATABASE_URL, e.g.:
 *   postgresql://<user>:<password>@<host>:26257/<db>?sslmode=verify-full
 * (CockroachCloud serverless URLs work too — anything the pg driver accepts.)
 */

const globalForCockroach = globalThis as unknown as { cockroachPool?: Pool };

export function getCockroachPool(): Pool {
  if (globalForCockroach.cockroachPool) return globalForCockroach.cockroachPool;

  const connectionString =
    process.env.COCKROACH_DATABASE_URL || '';
  if (!connectionString) {
    throw new Error('COCKROACH_DATABASE_URL environment variable is required');
  }

  const pool = new Pool({
    connectionString,
    max: process.env.NODE_ENV === 'production' ? 8 : 6,
    min: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 30_000,
    // CockroachCloud certs are issued by their own CA; Node needs this off
    // unless the user supplies sslrootcert in the connection string.
    ssl: connectionString.includes('sslmode=disable')
      ? undefined
      : { rejectUnauthorized: false },
  });

  pool.on('error', (err) => {
    console.error('[COCKROACH] Pool error:', err?.message);
  });

  globalForCockroach.cockroachPool = pool;

  // ── Warm-up + keepalive ──
  // Pay the TCP+TLS+auth handshake at boot instead of on the first request,
  // then ping periodically so idle connections aren't reaped mid-traffic.
  pool.query('SELECT 1').catch(() => {});
  const g = globalThis as any;
  if (!process.env.VERCEL && !g.__tirbeoCockroachKeepAlive) {
    const CRDB_KEEPALIVE_MS = 60_000;
    function scheduleCrdbKeepAlive() {
      g.__tirbeoCockroachKeepAlive = setTimeout(() => {
        pool.query('SELECT 1').catch(() => {});
        scheduleCrdbKeepAlive();
      }, CRDB_KEEPALIVE_MS);
    }
    scheduleCrdbKeepAlive();
    // Don't hold the process open just for the keepalive timer.
    g.__tirbeoCockroachKeepAlive?.unref?.();
  }

  return pool;
}

/** CockroachDB serialises TIMESTAMP as a microsecond-precision string. */
export type CrdbTimestamp = string | Date | null;

export function toMillis(value: CrdbTimestamp): number | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

// ─── Transient-error retry ───
// CockroachDB surfaces retryable failures as regular errors (SQLSTATE 40001
// serialization_failure, connection drops, "too many clients", …). Retrying
// with backoff + jitter turns them into successes instead of random 500s.

const RETRYABLE_PG_CODES = new Set([
  '40001', // serialization_failure
  '40003', // statement_completion_unknown
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08004', // sqlserver_rejected_establishment
  '53300', // too_many_connections
]);

export function isTransientCockroachError(err: any): boolean {
  if (!err) return false;
  if (RETRYABLE_PG_CODES.has(err.code)) return true;
  const msg = String(err?.message || '');
  return /connection (reset|refused|terminated)|server closed|too many clients|serialization|restart transaction|EOF/i.test(msg);
}

export async function withCockroachRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 150,
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isTransientCockroachError(err)) throw err;
      const delay = Math.min(baseDelayMs * 2 ** attempt + Math.random() * 100, 1500);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ─── Schema bootstrap (promise-cached, concurrent-safe) ───

let schemaPromise: Promise<void> | null = null;

/**
 * Create the CDN storage tables if they don't exist yet (idempotent).
 * Cached as a promise so concurrent first requests share one run and later
 * calls are ~free. Retries on the next call if bootstrap fails.
 */
export function ensureCockroachSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = doEnsureCockroachSchema().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

/**
 * One-time (per process) backfill: legacy rows stored their folder as a path
 * prefix in `filename` ("Tirbeo/Design/a.png"). Convert them into real nested
 * folder rows + re-parented files. Best-effort — failures never block serving.
 */
async function backfillLegacyFolderPaths(pool: Pool): Promise<void> {
  const g = globalThis as any;
  if (g.__tirbeoCdnPathBackfill) return;
  g.__tirbeoCdnPathBackfill = true;
  try {
    const legacy = await pool.query(
      `SELECT id, filename, parent_id FROM cdn_files
       WHERE folder = false AND filename LIKE '%/%' AND parent_id IS NULL`,
    );
    for (const row of legacy.rows as any[]) {
      const parts = String(row.filename).split('/').map((s: string) => s.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const name = parts.pop() as string;
      let parent: string | null = null;
      for (const segment of parts) {
        const found = await pool.query(
          `SELECT id FROM cdn_files WHERE folder = true AND deleted = false AND filename = $1 AND ${parent ? 'parent_id = $2' : '(parent_id IS NULL)'} LIMIT 1`,
          parent ? [segment, parent] : [segment],
        );
        if (found.rows.length > 0) {
          parent = found.rows[0].id;
        } else {
          const created = await pool.query(
            `INSERT INTO cdn_files (user_id, filename, s3_key, mime_type, size, content, folder, parent_id)
             VALUES ($1, $2, $3, 'application/x-tirbeo-folder', 0, $4, true, $5) RETURNING id`,
            [row.user_id ?? 'system', segment, `folder-${randomUUID()}`, Buffer.alloc(0), parent],
          );
          parent = created.rows[0].id;
        }
      }
      await pool.query(`UPDATE cdn_files SET filename = $2, parent_id = $3 WHERE id = $1`, [row.id, name, parent]);
    }
  } catch (err: any) {
    console.warn('[COCKROACH] Legacy path backfill skipped:', err?.message);
  }
}

async function doEnsureCockroachSchema(): Promise<void> {
  try {
    const pool = getCockroachPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cdn_files (
        id           STRING PRIMARY KEY DEFAULT gen_random_uuid()::STRING,
        user_id      STRING NOT NULL,
        filename     STRING NOT NULL,
        s3_key       STRING NOT NULL,
        mime_type    STRING NOT NULL DEFAULT 'application/octet-stream',
        size         INT8   NOT NULL DEFAULT 0,
        starred      BOOL   NOT NULL DEFAULT false,
        deleted      BOOL   NOT NULL DEFAULT false,
        content      BYTES  NOT NULL,
        content_type_header STRING,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_opened_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cdn_files_user ON cdn_files (user_id, deleted, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cdn_files_key ON cdn_files (s3_key)`);
    // ── Company-wide CDN: owner attribution (snapshot, survives account changes) ──
    await pool.query(`ALTER TABLE cdn_files ADD COLUMN IF NOT EXISTS owner_id STRING`).catch(() => {});
    await pool.query(`ALTER TABLE cdn_files ADD COLUMN IF NOT EXISTS owner_name STRING`).catch(() => {});
    await pool.query(`ALTER TABLE cdn_files ADD COLUMN IF NOT EXISTS owner_email STRING`).catch(() => {});
    // ── Per-file visibility gate: public (embed anywhere, no login) or
    // private (requires a valid signed URL to fetch via /u/...). ──
    await pool.query(`ALTER TABLE cdn_files ADD COLUMN IF NOT EXISTS visibility STRING NOT NULL DEFAULT 'public'`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cdn_files_visibility ON cdn_files (visibility)`).catch(() => {});
    // ── Nested folders (unlimited depth, company workspace) ──
    await pool.query(`ALTER TABLE cdn_files ADD COLUMN IF NOT EXISTS folder BOOL NOT NULL DEFAULT false`).catch(() => {});
    await pool.query(`ALTER TABLE cdn_files ADD COLUMN IF NOT EXISTS parent_id STRING`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cdn_files_parent ON cdn_files (parent_id)`).catch(() => {});
    // Legacy folder markers were zero-byte uploads with the reserved mime —
    // promote them to real folder rows once, so they resolve by id.
    await pool
      .query(`UPDATE cdn_files SET folder = true WHERE folder = false AND mime_type = 'application/x-tirbeo-folder' AND size = 0`)
      .catch(() => {});
    // Legacy path-prefixed rows ("Tirbeo/docs/a.png" as a flat filename) are
    // re-parented into real folder rows so the nested UI + /u/a/... URLs work.
    await backfillLegacyFolderPaths(pool);
    // One-time share links (single redeem, stored fully in CockroachDB)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cdn_share_links (
        token      STRING PRIMARY KEY,
        user_id    STRING NOT NULL,
        file_id    STRING NOT NULL,
        filename   STRING NOT NULL,
        mime_type  STRING NOT NULL,
        size       INT8   NOT NULL DEFAULT 0,
        redeemed   BOOL   NOT NULL DEFAULT false,
        redeemed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cdn_share_links_file ON cdn_share_links (file_id)`);
    // Optional share-link expiry — links can be created with a TTL.
    await pool.query(`ALTER TABLE cdn_share_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cdn_share_links_expiry ON cdn_share_links (expires_at)`).catch(() => {});
    // Access window for the REDEEMED content URL — after redeem, the raw
    // content link keeps working only briefly (copies of it die with it).
    await pool.query(`ALTER TABLE cdn_share_links ADD COLUMN IF NOT EXISTS content_expires_at TIMESTAMPTZ`).catch(() => {});
    // Folder-chain lookups (/u/a/<folders>/<file>) need id/parent/name/folder
    // for every row. A plain scan lands on the primary index, which carries
    // the inline file blobs — multi-second cold loads. This covering index
    // keeps the metadata walk on tiny rows that never touch blob storage.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cdn_files_parent_name ON cdn_files (parent_id, filename)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cdn_files_meta ON cdn_files (deleted) STORING (parent_id, filename, folder)`).catch(() => {});
    // Self-destruct expiries (created here so per-request DDL is never needed)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cdn_self_destruct (
        file_id    STRING PRIMARY KEY,
        user_id    STRING NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cdn_self_destruct_user ON cdn_self_destruct (user_id)`);
    // Per-user open tracking — powers the personal "Recent" feed.
    // (Org-wide recents derive from the same table across ALL users.)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cdn_file_opens (
        file_id   STRING NOT NULL,
        user_id   STRING NOT NULL,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (file_id, user_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cdn_file_opens_user ON cdn_file_opens (user_id, opened_at DESC)`).catch(() => {});
    // Path aliases — public /u/a/<path> links survive folder renames, file
    // renames, and moves. Every historical path maps to its file forever.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cdn_path_aliases (
        alias_path STRING PRIMARY KEY, -- lowercased folder chain + exact filename
        file_id    STRING NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cdn_path_aliases_file ON cdn_path_aliases (file_id)`).catch(() => {});
  } catch (err: any) {
    console.error('[COCKROACH] Schema bootstrap failed:', err?.message);
    throw err;
  }
}

// ─── Health check (cached — no SELECT 1 round-trip per request) ───

// 60s trust: every storage call ALSO exercises the pool, so a dead DB
// surfaces via real queries well before this TTL expires. The old 5s TTL
// meant every public-URL burst paid a serial SELECT 1 (≈0.5-1.5s each) on
// top of the actual data query.
const HEALTH_OK_TTL_MS = 60_000;  // trust a passing check for 60s
const HEALTH_FAIL_TTL_MS = 2_000; // retry a failing check quickly

const globalForHealth = globalThis as unknown as {
  __cockroachHealth?: { ok: boolean; at: number };
};

/**
 * Lightweight health check with a short-TTL cache so route handlers stop
 * paying a round-trip per request. Returns the cached verdict when fresh.
 */
export async function isCockroachHealthy(): Promise<boolean> {
  const g = globalForHealth;
  const cached = g.__cockroachHealth;
  const now = Date.now();
  if (cached) {
    const ttl = cached.ok ? HEALTH_OK_TTL_MS : HEALTH_FAIL_TTL_MS;
    if (now - cached.at < ttl) return cached.ok;
  }
  let ok = false;
  try {
    const pool = getCockroachPool();
    await pool.query('SELECT 1');
    ok = true;
  } catch {
    ok = false;
  }
  g.__cockroachHealth = { ok, at: now };
  return ok;
}
