// ─── Central Cache Registry ───
// Tracks all cache instances for monitoring via /api/debug/cache

interface CacheStats {
  name: string;
  size: number;
  maxSize: number;
  ttlMs: number;
  hits: number;
  misses: number;
  hitRate: number;
  createdAt: number;
}

const registry = new Map<string, { cache: ReturnType<typeof createTtlCacheInternal>; name: string; createdAt: number }>();

function registerCache(name: string, cache: ReturnType<typeof createTtlCacheInternal>) {
  registry.set(name, { cache, name, createdAt: Date.now() });
}

export function getAllCacheStats(): CacheStats[] {
  const stats: CacheStats[] = [];
  for (const [name, entry] of registry) {
    const { hits, misses, maxSize, ttlMs, size } = entry.cache.getStats();
    const total = hits + misses;
    stats.push({
      name,
      size,
      maxSize,
      ttlMs,
      hits,
      misses,
      hitRate: total > 0 ? Math.round((hits / total) * 100) : 0,
      createdAt: entry.createdAt,
    });
  }
  return stats;
}

export function resetAllCacheStats(): void {
  for (const [, entry] of registry) {
    entry.cache.resetStats();
  }
}

// ─── Internal Cache Implementation ───

function createTtlCacheInternal<T>(ttlMs: number, max = 1000) {
  const map = new Map<string, { value: T; expires: number }>();
  let hits = 0;
  let misses = 0;

  function prune() {
    const now = Date.now();
    for (const [k, v] of map) {
      if (v.expires <= now) map.delete(k);
    }
  }

  return {
    get(key: string): T | undefined {
      const entry = map.get(key);
      if (!entry) { misses++; return undefined; }
      if (entry.expires <= Date.now()) {
        map.delete(key);
        misses++;
        return undefined;
      }
      hits++;
      return entry.value;
    },
    set(key: string, value: T) {
      if (map.size >= max) prune();
      if (map.size >= max) {
        let oldest: string | null = null;
        let oldestExp = Infinity;
        for (const [k, v] of map) {
          if (v.expires < oldestExp) {
            oldest = k;
            oldestExp = v.expires;
          }
        }
        if (oldest) map.delete(oldest);
      }
      map.set(key, { value, expires: Date.now() + ttlMs });
    },
    delete(key: string) {
      map.delete(key);
    },
    deleteByPrefix(prefix: string) {
      for (const k of map.keys()) if (k.startsWith(prefix)) map.delete(k);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
    getStats() {
      prune(); // clean up expired before reporting
      return {
        hits,
        misses,
        size: map.size,
        maxSize: max,
        ttlMs,
      };
    },
    resetStats() {
      hits = 0;
      misses = 0;
    },
  };
}

/**
 * Create a TTL cache with automatic expiration and LRU eviction.
 * The cache is registered in the central registry for monitoring.
 */
export function createTtlCache<T>(ttlMs: number, max = 1000, name?: string) {
  const cache = createTtlCacheInternal<T>(ttlMs, max);
  if (name) {
    registerCache(name, cache);
  }
  return cache;
}
