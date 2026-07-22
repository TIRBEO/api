const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 30;
const AUTH_MAX = 5;

let redis: any = null;
const REDIS_URL = process.env.REDIS_URL;

async function getRedis() {
  if (redis !== null) return redis;
  if (REDIS_URL) {
    try {
      const { default: Redis } = await import('ioredis');
      redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true });
    } catch {
      redis = false;
    }
  } else {
    redis = false;
  }
  return redis;
}

export async function checkRateLimit(key: string, isAuth = false): Promise<boolean> {
  const max = isAuth ? AUTH_MAX : MAX_REQUESTS;
  const r = await getRedis();

  if (r) {
    try {
      const window = Math.floor(Date.now() / WINDOW_MS);
      const redisKey = `ratelimit:${key}:${window}`;
      const count = await r.incr(redisKey);
      if (count === 1) await r.pexpire(redisKey, WINDOW_MS);
      return count <= max;
    } catch {
      // fall through to in-memory
    }
  }

  const counters = (globalThis as any).__rateLimitCounters ?? new Map<string, { count: number; expires: number }>();
  (globalThis as any).__rateLimitCounters = counters;
  const now = Date.now();
  const entry = counters.get(key) ?? { count: 0, expires: now + WINDOW_MS };
  if (now > entry.expires) {
    entry.count = 0;
    entry.expires = now + WINDOW_MS;
  }
  entry.count++;
  counters.set(key, entry);
  return entry.count <= max;
}
