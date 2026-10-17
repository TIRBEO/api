import { prisma } from '@/infrastructure/db/prisma';

// Postgres fixed-window counter — the durable fallback for the Redis
// `ratelimit:*` / `vl:*` keys. `bucket` is floor(epochMs / windowMs), so every
// instance agrees on the same window boundary without coordination and a single
// upsert-with-increment is the atomic counter.
//
// These THROW on any DB error (including a missing table on a remote DB that
// hasn't run the migration yet). Callers MUST try/catch and fall back to
// Redis/in-memory — that guarded-fallback contract is why every subsystem keeps
// working before `db_oriented_state.sql` is applied.

export interface WindowConsume {
  /** Count after this hit was recorded. */
  count: number;
  /** True when `count <= limit`. */
  allowed: boolean;
  /** Epoch ms when the current window ends. */
  resetAt: number;
}

// Buckets are per-minute, so the table grows without bound unless something
// prunes expired windows. A throttled fire-and-forget delete rides along with
// consume — at most once per 30 min per process, no cron to deploy.
let lastPruneAt = 0;
const PRUNE_EVERY_MS = 30 * 60 * 1000;
function schedulePrune(): void {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now;
  prisma.rateLimitWindow
    .deleteMany({ where: { resetAt: { lt: new Date(now - 24 * 60 * 60 * 1000) } } })
    .catch(() => {});
}

/** Atomic consume: increment the fixed window and report capacity. Throws. */
export async function consumeWindow(key: string, limit: number, windowMs: number): Promise<WindowConsume> {
  const bucket = Math.floor(Date.now() / windowMs);
  const resetAt = (bucket + 1) * windowMs;
  schedulePrune();
  const row = await prisma.rateLimitWindow.upsert({
    where: { key_bucket: { key, bucket: BigInt(bucket) } },
    update: { count: { increment: 1 }, resetAt: new Date(resetAt) },
    create: { key, bucket: BigInt(bucket), count: 1, resetAt: new Date(resetAt) },
    select: { count: true },
  });
  return { count: row.count, allowed: row.count <= limit, resetAt };
}

/** Read-only current count of the active window (no increment). Throws. */
export async function peekWindow(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
  const bucket = Math.floor(Date.now() / windowMs);
  const row = await prisma.rateLimitWindow.findUnique({
    where: { key_bucket: { key, bucket: BigInt(bucket) } },
    select: { count: true },
  });
  return { count: row?.count ?? 0, resetAt: (bucket + 1) * windowMs };
}

/** Drop every window row whose key starts with `keyPrefix` (clear-on-success). */
export async function resetWindow(keyPrefix: string): Promise<void> {
  await prisma.rateLimitWindow.deleteMany({ where: { key: { startsWith: keyPrefix } } });
}
