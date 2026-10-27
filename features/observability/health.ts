import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma, getPoolStatus, getDetailedPoolStatus, checkDatabaseConnection, getPoolAlertState } from '@/infrastructure/db/prisma';
import { requirePermission } from '@/features/auth/http-guards';
import { jsonForbidden } from '@/shared/response';
import { getCachedRedisClient, checkRedisHealth, getRedisHealthSummary, pingAllRedisClients } from '@/infrastructure/db/redis';
import { deliveryDiagnostics } from '@/infrastructure/realtime/pusher-deliver';


/* Which internals are for staff, and which are for the world:
   `/api/health` is a liveness probe — an uptime check, a container orchestrator,
   the deploy platform. It answers alive-or-not and nothing else, because
   latencies, pool sizes, connection counts and the names of the environment
   variables that happen to be unset are a map of the installation for anybody
   who cares to ask.
   `/api/content/health` and `/api/health/pool` carry that detail and are gated on
   `dashboard.read`, which is the ops overview the numbers belong to. */

/** Trusted machine key for the monitoring pull, when one is configured. A length
    mismatch makes `timingSafeEqual` throw rather than return false, so the two
    are compared by length first and the secret never reaches the response. */
function adminKeyMatches(supplied: string): boolean {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected || !supplied) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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
      keepAliveInterval: 25_000 });
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

  const checks: Record<string, any> = {};
  let healthy = true;

  // ─── Database ───
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'ok' };
  } catch (e: any) {
    // The raw message can carry host/credential fragments, so it stays
    // server-side; only Prisma's error code is published.
    console.error('[HEALTH] Database check failed:', e?.code || '', e?.message || e);
    checks.database = {
      status: 'error',
      code: typeof e?.code === 'string' ? e.code : undefined,
    };
    healthy = false;
  }

  // ─── Redis ───
  const r = getHealthRedis();
  if (r) {
    const redisHealth = await checkRedisHealth(r);
    checks.redis = { status: redisHealth.ok ? 'ok' : 'error' };
    if (!redisHealth.ok) {
      console.error('[HEALTH] Redis check failed:', redisHealth.error || '');
      healthy = false;
    }
  } else {
    checks.redis = { status: process.env.REDIS_URL ? 'error' : 'not-configured' };
    if (process.env.REDIS_URL) healthy = false;
  }

  const result = {
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks };
  healthCache = { data: result, ts: Date.now() };
  return NextResponse.json(result);
}

export async function detailedHealthHandler(req: NextRequest) {
  const staff = await requirePermission(req, 'dashboard.read');
  if (staff instanceof NextResponse) return staff;

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

  // ─── Redis health (PING) ───
  const r = getHealthRedis();
  if (r) {
    const redisHealth = await checkRedisHealth(r);
    checks.redis = {
      status: redisHealth.ok ? 'ok' : 'error',
      latencyMs: redisHealth.latencyMs,
      error: redisHealth.error || undefined };
    if (!redisHealth.ok) healthy = false;
  } else {
    checks.redis = { status: process.env.REDIS_URL ? 'error' : 'not-configured' };
  }

  // ─── Per-client Redis PING latencies ───
  const pingResults = await pingAllRedisClients();
  if (Object.keys(pingResults).length > 0) {
    checks.redisPing = pingResults;
  }

  // ─── Redis connection states ───
  const redisSummary = getRedisHealthSummary();
  checks.redisConnections = {
    configured: redisSummary.configured,
    total: redisSummary.totalClients,
    connected: redisSummary.connectedClients,
    reconnects: redisSummary.totalReconnects,
    failedRequests: redisSummary.totalFailedRequests,
    allHealthy: redisSummary.totalClients === 0 || redisSummary.connectedClients === redisSummary.totalClients,
    clients: redisSummary.clients };
  if (redisSummary.totalClients > 0 && redisSummary.connectedClients === 0) {
    healthy = false;
  }

  // ─── Realtime + web push delivery (Pusher Channels / Beams) ───
  // The admin view DOES count a degraded delivery layer against overall
  // health, so an operator tailing this endpoint is told loudly.
  const delivery = deliveryDiagnostics();
  checks.delivery = delivery;
  if (delivery.status !== 'ok') healthy = false;

  try {
    const recentCriticalEvents = await prisma.activityEvent.findMany({
      where: { severity: 'critical', createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, kind: true, detail: true, createdAt: true } });
    checks.recentCriticalEvents = recentCriticalEvents;
  } catch (e: any) {
    checks.recentCriticalEvents = { status: 'error', error: e?.message };
  }

  const poolStatus = getPoolStatus();
  return NextResponse.json({
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || 'development',
    version: process.env.npm_package_version || '0.0.1',
    checks,
    pool: poolStatus || undefined });
}

// ─── GET /api/health/pool ───
// Detailed connection pool metrics for monitoring dashboards.
// Returns real-time pool state, utilization, health indicators, and memory usage.
export async function poolHealthHandler(req: NextRequest) {
  /* Who is allowed the pool's internals: a staff session that holds
     `dashboard.read`, or the machine key an external monitor presents in
     `x-admin-key`. Nobody else — this endpoint sits under the same path as the
     public liveness probe, and a prefix-shaped public door used to hand it to
     anybody who asked. */
  const machineKey = adminKeyMatches(req.headers.get('x-admin-key') || '');
  if (!machineKey) {
    const staff = await requirePermission(req, 'dashboard.read');
    if (staff instanceof NextResponse) return staff;
  }

  const detailed = getDetailedPoolStatus();
  if (!detailed) {
    return NextResponse.json({ error: 'Pool not initialized' }, { status: 503 });
  }

  // Quick DB latency check
  const dbCheck = await checkDatabaseConnection();

  const alertState = getPoolAlertState();

  const response = {
    timestamp: new Date().toISOString(),
    database: {
      connected: dbCheck.ok,
      latencyMs: dbCheck.latencyMs },
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
      thresholds: alertState.thresholds } };

  return NextResponse.json(response);
}
