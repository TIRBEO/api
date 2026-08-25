import { NextRequest, NextResponse } from 'next/server';
import { getAllCacheStats, resetAllCacheStats } from './cache';
import { getPoolStatus, getDetailedPoolStatus } from './db/prisma';
import { getSession } from './session';
import { getQueryPerformanceStats, resetQueryStats, updateAlertConfig, getAlertConfig } from './queryMonitor';

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

/**
 * GET /api/debug/query-perf
 * Returns performance stats for all tracked index-backed queries.
 * Shows p50/p95/p99 latencies, query counts, and recent samples.
 * Admin-only endpoint.
 */
export async function queryPerfDebugHandler(req: NextRequest) {
  const session = await getSession(req).catch(() => null);
  if (process.env.NODE_ENV !== 'development' && !session?.userId) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  return NextResponse.json(getQueryPerformanceStats());
}

/**
 * POST /api/debug/query-perf/reset
 * Resets all tracked query performance stats.
 */
export async function queryPerfResetDebugHandler(req: NextRequest) {
  const session = await getSession(req).catch(() => null);
  if (!session?.userId) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  resetQueryStats();
  return NextResponse.json({ message: 'Query performance stats reset', timestamp: new Date().toISOString() });
}

/**
 * GET /api/debug/query-perf/config
 * Returns current alert configuration.
 */
export async function queryPerfConfigDebugHandler(req: NextRequest) {
  const session = await getSession(req).catch(() => null);
  if (process.env.NODE_ENV !== 'development' && !session?.userId) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  return NextResponse.json({ config: getAlertConfig() });
}

/**
 * PUT /api/debug/query-perf/config
 * Update alert thresholds at runtime.
 * Body: { warningThresholdMs?, criticalThresholdMs?, minSamples?, cooldownMs? }
 */
export async function queryPerfConfigUpdateDebugHandler(req: NextRequest) {
  const session = await getSession(req).catch(() => null);
  if (!session?.userId) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  try {
    const body: any = await req.json();
    const config: Record<string, number> = {};
    if (typeof body.warningThresholdMs === 'number' && body.warningThresholdMs > 0) config.warningThresholdMs = body.warningThresholdMs;
    if (typeof body.criticalThresholdMs === 'number' && body.criticalThresholdMs > 0) config.criticalThresholdMs = body.criticalThresholdMs;
    if (typeof body.minSamples === 'number' && body.minSamples > 0) config.minSamples = body.minSamples;
    if (typeof body.cooldownMs === 'number' && body.cooldownMs > 0) config.cooldownMs = body.cooldownMs;

    if (Object.keys(config).length === 0) {
      return NextResponse.json({ error: 'No valid config fields provided' }, { status: 400 });
    }

    updateAlertConfig(config);
    return NextResponse.json({ message: 'Alert config updated', config: getAlertConfig() });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
