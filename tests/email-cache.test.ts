import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The send path's cache, and the two promises it makes:
 *
 *   1. a hit is a hit — the database is not asked again;
 *   2. no Redis is not a failure — every read falls through to the query that
 *      ran before the cache existed.
 *
 * A third thing is checked because it is the one a cache gets wrong: an absent
 * row ("nobody has overridden this template") is an answer, and must not be
 * re-queried for every mail of a broadcast.
 */

const store = new Map<string, string>();
const fake = {
  get: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
  set: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (...keys: string[]) => {
    let n = 0;
    for (const key of keys) if (store.delete(key)) n++;
    return n;
  }),
};

vi.mock('@/infrastructure/db/redis', () => ({
  getCachedRedisClient: () => fake,
}));

async function loadCache() {
  vi.resetModules();
  return import('@/features/email/emailCache');
}

beforeEach(() => {
  store.clear();
  fake.get.mockClear();
  fake.set.mockClear();
  fake.del.mockClear();
  process.env.REDIS_URL = 'redis://localhost:6379';
});

afterEach(() => {
  delete process.env.REDIS_URL;
});

describe('cachedEmailRead', () => {
  it('builds once, then serves the answer from the store', async () => {
    const { cachedEmailRead, EMAIL_CACHE_KEYS, EMAIL_CACHE_TTL } = await loadCache();
    const build = vi.fn(async () => ({ provider: 'resend' }));

    const first = await cachedEmailRead(EMAIL_CACHE_KEYS.switches, EMAIL_CACHE_TTL.switches, build);
    const second = await cachedEmailRead(EMAIL_CACHE_KEYS.switches, EMAIL_CACHE_TTL.switches, build);

    expect(build).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(fake.set).toHaveBeenCalledTimes(1);
  });

  it('treats a missing row as an answer rather than a miss', async () => {
    const { cachedEmailRead, EMAIL_CACHE_KEYS, EMAIL_CACHE_TTL } = await loadCache();
    const build = vi.fn(async () => null);

    await expect(
      cachedEmailRead(EMAIL_CACHE_KEYS.template('welcome'), EMAIL_CACHE_TTL.template, build),
    ).resolves.toBeNull();
    await expect(
      cachedEmailRead(EMAIL_CACHE_KEYS.template('welcome'), EMAIL_CACHE_TTL.template, build),
    ).resolves.toBeNull();

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('invalidates exactly the key a writer names', async () => {
    const { cachedEmailRead, invalidateEmailCache, EMAIL_CACHE_KEYS, EMAIL_CACHE_TTL } =
      await loadCache();
    const build = vi.fn(async () => ({ html: '<p>old</p>' }));
    const key = EMAIL_CACHE_KEYS.template('welcome');

    await cachedEmailRead(key, EMAIL_CACHE_TTL.template, build);
    await invalidateEmailCache(key);
    await cachedEmailRead(key, EMAIL_CACHE_TTL.template, build);

    expect(build).toHaveBeenCalledTimes(2);
    expect(fake.del).toHaveBeenCalledWith(key);
  });

  it('reads the database when Redis errors, instead of losing the mail', async () => {
    const { cachedEmailRead, EMAIL_CACHE_KEYS, EMAIL_CACHE_TTL } = await loadCache();
    fake.get.mockRejectedValueOnce(new Error('connection reset'));
    fake.set.mockRejectedValueOnce(new Error('connection reset'));
    const build = vi.fn(async () => ({ provider: 'smtp' }));

    await expect(
      cachedEmailRead(EMAIL_CACHE_KEYS.switches, EMAIL_CACHE_TTL.switches, build),
    ).resolves.toEqual({ provider: 'smtp' });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('lets a build error reach the caller rather than hiding it as a miss', async () => {
    const { cachedEmailRead, EMAIL_CACHE_KEYS, EMAIL_CACHE_TTL } = await loadCache();
    await expect(
      cachedEmailRead(EMAIL_CACHE_KEYS.switches, EMAIL_CACHE_TTL.switches, async () => {
        throw new Error('db down');
      }),
    ).rejects.toThrow('db down');
    // Nothing was stored for a read that never answered.
    expect(fake.set).not.toHaveBeenCalled();
  });

  it('works with no Redis configured at all', async () => {
    delete process.env.REDIS_URL;
    const { cachedEmailRead, invalidateEmailCache, EMAIL_CACHE_KEYS, EMAIL_CACHE_TTL } =
      await loadCache();
    const build = vi.fn(async () => ({ provider: 'resend' }));

    await cachedEmailRead(EMAIL_CACHE_KEYS.switches, EMAIL_CACHE_TTL.switches, build);
    await cachedEmailRead(EMAIL_CACHE_KEYS.switches, EMAIL_CACHE_TTL.switches, build);
    await invalidateEmailCache(EMAIL_CACHE_KEYS.switches);

    expect(build).toHaveBeenCalledTimes(2);
    expect(fake.get).not.toHaveBeenCalled();
  });
});

describe('cachedConfigRead', () => {
  it('holds the credential-bearing config in this process, never in Redis', async () => {
    const { cachedConfigRead, invalidateConfigCache, EMAIL_CACHE_KEYS } = await loadCache();
    const build = vi.fn(async () => ({ apiKey: 're_secret', smtpPass: 'hunter2' }));

    await cachedConfigRead(EMAIL_CACHE_KEYS.config, build);
    await cachedConfigRead(EMAIL_CACHE_KEYS.config, build);

    expect(build).toHaveBeenCalledTimes(1);
    // The whole point: a provider key must not be copied into the shared store.
    expect(fake.set).not.toHaveBeenCalled();
    expect([...store.keys()]).toEqual([]);

    invalidateConfigCache(EMAIL_CACHE_KEYS.config);
    await cachedConfigRead(EMAIL_CACHE_KEYS.config, build);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
