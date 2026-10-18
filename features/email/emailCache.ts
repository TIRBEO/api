import { getCachedRedisClient } from '@/infrastructure/db/redis';
import { createTtlCache } from '@/infrastructure/cache';

/**
 * The reads a send makes, kept out of Postgres.
 *
 * Every mail used to ask the database five times before it asked the provider
 * once: the sender config, the platform's category switches, the admin's
 * template override, the address's owner, and that person's notification
 * preferences — on a route that is already paying for an SMTP round trip. A
 * broadcast of ten thousand mails is fifty thousand queries for answers that
 * change a handful of times a day.
 *
 * Redis holds the answers; the sender still lives in `apps/api` alone, so the
 * provider key never leaves it. A miss, a timeout or no `REDIS_URL` at all
 * reads the database exactly the way this code did before the cache existed —
 * mail is never lost because the cache was having a bad day, and a suppression
 * decision is never invented.
 *
 * Every write path deletes its own key (`invalidateEmailCache`); the TTL is the
 * backstop for a write that forgot to. Per-person keys are keyed by user id
 * rather than address, because a change to one account has to be able to drop
 * every address that points at it.
 */

/** Long enough to absorb a broadcast, short enough that a write which forgot to
    invalidate is a brief inconsistency rather than a lasting one. */
export const EMAIL_CACHE_TTL = {
  switches: 60,
  template: 300,
} as const;

/** The key names, in one place, so a writer cannot miss the reader.
    Deliberately absent: the recipient's notification preferences and the
    address → user lookup. Both are consent decisions, and a stale answer to
    either is mail to somebody who just said no. */
export const EMAIL_CACHE_KEYS = {
  config: 'email:cfg',
  switches: 'email:switches',
  template: (slug: string) => `email:tpl:${slug}`,
};

let client: any = null; // null = not tried yet, false = no Redis for this deployment

function redis(): any {
  if (client !== null) return client;
  const url = process.env.REDIS_URL;
  if (!url) return (client = false);
  try {
    client = getCachedRedisClient('email-cache', { url, enableKeepAlive: false });
  } catch {
    client = false;
  }
  return client;
}

/** A missing row is an answer too: without it, a broadcast against a template
    nobody has overridden re-queries the row for every single mail. */
const ABSENT = '__email_cache_absent__';

/**
 * Read the cached answer, or build it and store that.
 *
 * `build` runs exactly as it does today when there is no hit, so a caller's own
 * error handling is untouched: a throw inside it reaches the caller instead of
 * being swallowed as a miss.
 */
export async function cachedEmailRead<T>(
  key: string,
  ttlSeconds: number,
  build: () => Promise<T>,
): Promise<T> {
  const store = redis();
  if (!store) return build();

  try {
    const hit = await store.get(key);
    if (hit === ABSENT) return null as T;
    if (hit !== null) return JSON.parse(hit) as T;
  } catch {
    return build();
  }

  const value = await build();
  try {
    await store.set(
      key,
      value === null || value === undefined ? ABSENT : JSON.stringify(value),
      'EX',
      ttlSeconds,
    );
  } catch {
    /* the answer is still correct for this send */
  }
  return value;
}

/**
 * Drop keys after a write.
 *
 * Call it from the handler that made the change, and never lean on the TTL to
 * notice: someone who has just unsubscribed must not be mailable for another
 * two minutes because a cache held the old answer.
 */
export async function invalidateEmailCache(...keys: string[]): Promise<void> {
  const store = redis();
  if (!store || !keys.length) return;
  try {
    await store.del(...keys);
  } catch {
    /* the TTL expires it */
  }
}

/**
 * Drop a template's cached override after an admin edits, creates or deletes it.
 *
 * Six handlers write `emailTemplate`, so the key shape lives here rather than at
 * each of them — a writer cannot miss a key it never has to spell.
 */
export function invalidateEmailTemplate(slug: string): Promise<void> {
  return invalidateEmailCache(EMAIL_CACHE_KEYS.template(slug));
}

/* ── The one answer that must not go to Redis ─────────────────────────────
   The sender config row (`AppConfig['email.config']`) holds `apiKey` and
   `smtpPass` in plaintext — the admin panel writes them there
   (`app/api/admin/email/config/route.ts:21,25`). Caching that row in Redis
   would copy live provider credentials into a second store, readable by
   anything with the connection string, to save one query per send.

   So the credential-bearing read is held in this process only: the secret
   stays exactly where it already lived, and a broadcast of ten thousand mails
   still asks the database once per instance instead of once per mail. Its TTL
   is short and per-instance, which is the honest trade — a config change
   lands on every instance within `CONFIG_TTL_MS`, not on the next request. */

const CONFIG_TTL_MS = 60_000;
const memory = createTtlCache<any>(CONFIG_TTL_MS, 64, 'email-config');

export async function cachedConfigRead<T>(key: string, build: () => Promise<T>): Promise<T> {
  const hit = memory.get(key);
  if (hit !== undefined) return hit as T;
  const value = await build();
  memory.set(key, value);
  return value;
}

/** Drop a held config after an admin writes it, here and now. */
export function invalidateConfigCache(key: string): void {
  memory.delete(key);
}
