/**
 * Email Brain — Secure variable store.
 *
 * Security-critical values (OTP codes, reset tokens/URLs) NEVER go into
 * `email_jobs.payload` or any DB row. They live in Redis under a random id,
 * with a TTL that matches (or is shorter than) the secret's own lifetime.
 * The job payload carries only the ref id; the queue worker's resolver
 * fetches the secret at send time and the key is consumed (deleted).
 *
 * Redis unavailable → store fails closed: callers MUST treat that as "do not
 * enqueue" rather than falling back to storing secrets in the DB payload.
 */
import { getRedis } from '@/features/auth/redis';

const PREFIX = 'emailbrain:sv:';
const DEFAULT_TTL_S = 15 * 60; // matches RESET_TTL_MINUTES

export interface SecureRef { ref: string; ttlS: number }

/** Store a secret; returns the reference id to embed in the job payload. */
export async function putSecureVars(
  values: Record<string, string>,
  ttlS = DEFAULT_TTL_S,
): Promise<SecureRef | null> {
  const redis = getRedis();
  if (!redis) return null; // fail closed
  try {
    const ref = crypto.randomUUID();
    await redis.set(PREFIX + ref, JSON.stringify(values), 'EX', ttlS);
    return { ref, ttlS };
  } catch (e: any) {
    console.error('[EMAIL_BRAIN][SECURE_VARS] put failed:', e?.message);
    return null;
  }
}

/**
 * Fetch-and-delete (consume) — the secret is used exactly once at send time.
 * If the worker retries the send after a transient failure, the resolver
 * returns null and the send fails instead of going out with a stale secret.
 */
export async function takeSecureVars(ref: string): Promise<Record<string, string> | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const val = await redis.get(PREFIX + ref);
    if (!val) return null;
    // Consume: delete after read (GETDEL when available, GET+DEL otherwise).
    try { await redis.sendCommand(['GETDEL', PREFIX + ref]); } catch {
      await redis.del(PREFIX + ref);
    }
    return JSON.parse(val);
  } catch (e: any) {
    console.error('[EMAIL_BRAIN][SECURE_VARS] take failed:', e?.message);
    return null;
  }
}

/** Peek without consuming (diagnostics only). */
export async function peekSecureVars(ref: string): Promise<Record<string, string> | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const val = await redis.get(PREFIX + ref);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}
