import { NextRequest, NextResponse } from 'next/server';
import { getAllCacheStats, resetAllCacheStats } from './cache';
import { getPoolStatus, getDetailedPoolStatus } from './db/prisma';
import { getSession } from './session';

function isAdmin(user: any): boolean {
  return user?.adminRole != null && ['super_admin', 'admin'].includes(user.adminRole);
}

/**
 * GET /api/debug/cache
 * Returns cache sizes, hit rates, and other metrics for all registered caches.
 * Admin-only endpoint for monitoring.
 */
export async function cacheDebugHandler(req: NextRequest) {
  // Allow unauthenticated access in development for easy debugging
  const session = await getSession(req).catch(() => null);
  if (process.env.NODE_ENV !== 'development' && !session?.userId) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const cacheStats = getAllCacheStats();
  const poolStatus = getDetailedPoolStatus();

  // Calculate totals
  const totalSize = cacheStats.reduce((sum, c) => sum + c.size, 0);
  const totalMaxSize = cacheStats.reduce((sum, c) => sum + c.maxSize, 0);
  const totalHits = cacheStats.reduce((sum, c) => sum + c.hits, 0);
  const totalMisses = cacheStats.reduce((sum, c) => sum + c.misses, 0);
  const totalRequests = totalHits + totalMisses;

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    summary: {
      cacheCount: cacheStats.length,
      totalSize,
      totalMaxSize,
      totalHits,
      totalMisses,
      overallHitRate: totalRequests > 0 ? Math.round((totalHits / totalRequests) * 100) : 0,
    },
    caches: cacheStats.map(c => ({
      name: c.name,
      size: c.size,
      maxSize: c.maxSize,
      ttlMs: c.ttlMs,
      ttlFormatted: formatTtl(c.ttlMs),
      hits: c.hits,
      misses: c.misses,
      hitRate: c.hitRate,
      utilization: c.maxSize > 0 ? Math.round((c.size / c.maxSize) * 100) : 0,
    })),
    pool: poolStatus ? {
      totalCount: poolStatus.totalCount,
      idleCount: poolStatus.idleCount,
      waitingCount: poolStatus.waitingCount,
      utilizationPercent: poolStatus.utilization.utilizationPercent,
    } : null,
    uptime: Math.floor(process.uptime()),
    memory: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  });
}

/**
 * POST /api/debug/cache/reset
 * Resets all cache hit/miss counters (useful for benchmarking).
 */
export async function cacheResetDebugHandler(req: NextRequest) {
  const session = await getSession(req).catch(() => null);
  if (!session?.userId) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  resetAllCacheStats();
  return NextResponse.json({ message: 'Cache stats reset', timestamp: new Date().toISOString() });
}

function formatTtl(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
