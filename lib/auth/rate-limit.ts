import { recordRateLimitHit } from './suspicious-activity';

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 30;
const AUTH_MAX = 5;

interface ApiLimits {
  rateLimitEnabled: boolean;
  rateLimitPerMinute: number;
}

let cachedLimits: ApiLimits | null = null;
let cachedAt = 0;
const CONFIG_TTL = 30_000;

async function getApiLimits(): Promise<ApiLimits> {
  if (cachedLimits && Date.now() - cachedAt < CONFIG_TTL) return cachedLimits;
  let limits: ApiLimits = { rateLimitEnabled: true, rateLimitPerMinute: MAX_REQUESTS };
  try {
    const { prisma } = await import('../db/prisma');
    const record = await prisma.siteConfig.findUnique({ where: { app: 'api' } });
    const c: any = record?.config || {};
    limits = {
      rateLimitEnabled: c.rateLimitEnabled !== undefined ? !!c.rateLimitEnabled : true,
      rateLimitPerMinute: typeof c.rateLimitPerMinute === 'number' && c.rateLimitPerMinute > 0
        ? c.rateLimitPerMinute
        : MAX_REQUESTS,
    };
  } catch {}
  cachedLimits = limits;
  cachedAt = Date.now();
  return limits;
}

const ROUTE_LIMITS: Record<string, number> = {
  'auth/login': 10,
  'auth/signup': 5,
  'auth/email-exists': 20,
  'auth/email-otp/request': 5,
  'auth/phone-otp/request': 5,
  'auth/magic-link/request': 5,
  'auth/password-reset/request': 5,
  'auth/signup-otp/request': 5,
  'auth/login-otp/request': 5,
  'auth/login-otp/verify': 10,
  'auth/verify-email': 10,
  'auth/password-reset/verify': 10,
  'auth/password-reset/confirm': 5,
  'auth/magic-link/verify': 10,
  'security/totp/setup': 10,
  'security/totp/verify': 10,
  'security/password': 10,
  'network/follow': 30,
  'network/following': 60,
  'profile-views/track': 60,
  'forms/public/[publicId]/submit': 10,
  'feedback': 5,
  'waitlist': 5,
};

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

export async function checkRateLimit(key: string, isAuth = false, routeLimit?: number): Promise<boolean> {
  const limits = await getApiLimits();
  if (!limits.rateLimitEnabled) return true;
  const configuredMax = limits.rateLimitPerMinute;
  const defaultMax = isAuth ? AUTH_MAX : MAX_REQUESTS;
  const max = Math.min(routeLimit ?? defaultMax, configuredMax);
  const r = await getRedis();

  if (r) {
    try {
      const window = Math.floor(Date.now() / WINDOW_MS);
      const redisKey = `ratelimit:${key}:${window}`;
      const count = await r.incr(redisKey);
      if (count === 1) await r.pexpire(redisKey, WINDOW_MS);
      if (count > max) {
        recordRateLimitHit(key.split(':')[0]);
      }
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
  if (entry.count > max) {
    recordRateLimitHit(key.split(':')[0]);
  }
  return entry.count <= max;
}

export { ROUTE_LIMITS };

