import { NextRequest, NextResponse } from 'next/server';
import { prisma, getPoolStatus, getDetailedPoolStatus, checkDatabaseConnection, getPoolAlertState } from './db/prisma';
import { getSession } from './session';
import { jsonUnauthorized, jsonForbidden } from './response';
import { getCachedRedisClient, checkRedisHealth, getAllRedisStates } from './db/redis';


function isAdmin(user: any): boolean {
  return user?.adminRole != null && ['super_admin', 'admin'].includes(user.adminRole);
}

function isAdminUser(user: any): boolean {
  return isAdmin(user);
}

// Cache health check results for 15s to avoid hammering DB/Redis on every request
let healthCache: { data: any; ts: number } | null = null;
const HEALTH_CACHE_TTL = 15_000;

// Shared Redis connection for health checks (avoids creating/destroying a connection every 15s)
let healthRedis: any = null;
let healthRedisFailed = false;

function getHealthRedis(): any {
  if (healthRedisFailed) return null;
  if (healthRedis) return healthRedis;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;
  try {
    healthRedis = getCachedRedisClient('health', {
      url: redisUrl,
      enableKeepAlive: true,
      keepAliveInterval: 25_000,
    });
    return healthRedis;
  } catch {
    healthRedisFailed = true;
    return null;
  }
}

export async function publicHealthHandler() {
  // Return cached result if fresh enough
  if (healthCache && Date.now() - healthCache.ts < HEALTH_CACHE_TTL) {
    return NextResponse.json(healthCache.data);
  }

  const checks: Record<string, string> = {};
  let healthy = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
    healthy = false;
  }

  const r = getHealthRedis();
  if (r) {
    const redisHealth = await checkRedisHealth(r);
    checks.redis = redisHealth.ok ? 'ok' : 'error';
    if (!redisHealth.ok) {
      healthy = false;
    }
  } else {
    checks.redis = process.env.REDIS_URL ? 'error' : 'not-configured';
    if (!process.env.REDIS_URL) healthy = false;
  }

  const poolStatus = getPoolStatus();
  const result = {
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
    pool: poolStatus || undefined,
  };
  healthCache = { data: result, ts: Date.now() };
  return NextResponse.json(result);
}

export async function detailedHealthHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  if (!isAdmin(user)) return jsonForbidden();

  const checks: Record<string, any> = {};
  let healthy = true;

  try {
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'ok', latencyMs: Date.now() - dbStart };
  } catch (e: any) {
    checks.database = { status: 'error', error: e?.message };
    healthy = false;
  }

  const r = getHealthRedis();
  if (r) {
    const redisHealth = await checkRedisHealth(r);
    checks.redis = {
      status: redisHealth.ok ? 'ok' : 'error',
      latencyMs: redisHealth.latencyMs,
      error: redisHealth.error,
    };
    if (!redisHealth.ok) {
      healthy = false;
    }
  } else {
    checks.redis = { status: 'not-configured' };
  }

  // Add Redis connection states for diagnostics
  const redisStates = getAllRedisStates();
  if (Object.keys(redisStates).length > 0) {
    checks.redisConnections = redisStates;
  }

  try {
    const [pendingJobs, failedJobs] = await Promise.all([
      prisma.jobs.count({ where: { status: 'pending' } }),
      prisma.jobs.count({ where: { status: 'failed' } }),
    ]);
    checks.queue = { pendingJobs, failedJobs };
  } catch (e: any) {
    checks.queue = { status: 'error', error: e?.message };
    healthy = false;
  }

  const recentIncidents = await prisma.incidents.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: 'desc' }, take: 5 });

  const poolStatus = getPoolStatus();
  return NextResponse.json({
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || 'development',
    version: process.env.npm_package_version || '0.0.1',
    checks,
    pool: poolStatus || undefined,
    incidents: recentIncidents,
  });
}

// ─── GET /api/health/pool ───
// Detailed connection pool metrics for monitoring dashboards.
// Returns real-time pool state, utilization, health indicators, and memory usage.
export async function poolHealthHandler(req: NextRequest) {
  // Optional: require admin auth for detailed pool metrics
  const authHeader = req.headers.get('authorization');
  const adminKey = req.headers.get('x-admin-key');
  const session = await getSession(req).catch(() => null);
  const isAdmin = (session?.userId && isAdminUser(session)) || !!adminKey;

  // Allow unauthenticated access for basic metrics, but require admin for full details
  const detailed = getDetailedPoolStatus();
  if (!detailed) {
    return NextResponse.json({ error: 'Pool not initialized' }, { status: 503 });
  }

  // Quick DB latency check
  const dbCheck = await checkDatabaseConnection();

  const alertState = getPoolAlertState();

  const response: any = {
    timestamp: new Date().toISOString(),
    database: {
      connected: dbCheck.ok,
      latencyMs: dbCheck.latencyMs,
    },
    pool: detailed,
    alerts: {
      isExhausted: alertState.isExhausted,
      waitingDurationMs: alertState.waitingDurationMs,
      waitingDurationFormatted: alertState.waitingDurationMs > 0
        ? `${Math.round(alertState.waitingDurationMs / 1000)}s`
        : '0s',
      totalAlerts: alertState.alertCount,
      lastWarningAt: alertState.lastWarningAt ? new Date(alertState.lastWarningAt).toISOString() : null,
      lastCriticalAt: alertState.lastCriticalAt ? new Date(alertState.lastCriticalAt).toISOString() : null,
      thresholds: alertState.thresholds,
    },
  };

  // Admin-only: include memory and full config
  if (!isAdmin) {
    delete response.pool.memory;
    delete response.pool.config;
  }

  return NextResponse.json(response);
}
