import Redis from 'ioredis';

type SessionState = {
  userId: string;
  revoked: boolean;
  createdAt: number;
  lastSeenIp: string | null;
  deviceInfo: string | null;
  revokedAt?: number;
};

const REDIS_URL = process.env.REDIS_URL;

let _client: Redis | null = null;

export function getRedis(): Redis | null {
  if (typeof window !== 'undefined') return null;
  if (!REDIS_URL) return null;
  if (!_client) {
    _client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
    });
  }
  return _client;
}

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_KEY = (sid: string) => `auth:session:${sid}`;
const SPENT_KEY = (hash: string) => `auth:refresh_spent:${hash}`;

export async function getSessionState(sessionId: string): Promise<SessionState | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(SESSION_KEY(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

export async function saveSessionState(state: SessionState & { sessionId: string }): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.setex(SESSION_KEY(state.sessionId), Math.ceil(REFRESH_TTL_MS / 1000), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export async function revokeSessionState(sessionId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    const cache = (globalThis as any).__authSessionState as Map<string, SessionState> | undefined;
    if (cache?.has(sessionId)) cache.delete(sessionId);
    return false;
  }
  try {
    await redis.del(SESSION_KEY(sessionId));
  } catch {
    /* fall through to fallback */
  }
  const fallback = (globalThis as any).__authSessionState as Map<string, SessionState> | undefined;
  if (fallback?.has(sessionId)) {
    const st = fallback.get(sessionId);
    st!.revoked = true;
    st!.revokedAt = Date.now();
    fallback.set(sessionId, st as SessionState);
  }
  return true;
}

export async function markRefreshSpent(hash: string, sessionId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const key = SPENT_KEY(hash);
    await redis.setex(key, Math.ceil(REFRESH_TTL_MS / 1000), sessionId);
    return true;
  } catch {
    return false;
  }
}

export async function isRefreshSpent(hash: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.get(SPENT_KEY(hash));
  } catch {
    return null;
  }
}

export const REFRESH_TOKEN_BYTES = 32;

export function generateRefreshToken(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(REFRESH_TOKEN_BYTES);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  }
  const nodeCrypto = require('crypto');
  return nodeCrypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export async function hashRefreshToken(token: string): Promise<string> {
  const nodeCrypto = require('crypto');
  return nodeCrypto.createHash('sha256').update(token).digest('hex');
}

function base64url(bytes: Uint8Array): string {
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return Buffer.from(bin, 'binary').toString('base64url');
}
