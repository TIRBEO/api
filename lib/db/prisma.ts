import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient; pgPool: Pool };

// ─── Connection Pool Configuration ───
// Tuned for Supabase PostgreSQL with PgBouncer in transaction mode.
// Supabase free tier allows ~60 concurrent connections; we keep our pool
// conservative to leave room for migrations and other services.
const POOL_CONFIG = {
  // Maximum number of clients in the pool.
  // Local dev: higher pool to handle concurrent requests from dashboard/forms/admin.
  // Vercel prod: keep conservative for Supabase's connection limit.
  max: process.env.NODE_ENV === 'production' ? 5 : 10,
  // Minimum idle clients kept alive to avoid cold-start latency.
  min: process.env.NODE_ENV === 'production' ? 2 : 4,
  // Milliseconds a client can sit idle before being destroyed.
  // Supabase's pooler has its own idle timeout; ours should be shorter.
  idleTimeoutMillis: 30_000,
  // Milliseconds to wait for a connection before timing out.
  // Supabase cold connections can take 5-10s; set generous timeout.
  connectionTimeoutMillis: 45_000,
  // Allow idle clients to be reaped faster in development
  // where instances are short-lived.
  ...(process.env.NODE_ENV !== 'production'
    ? { max: 10, min: 4, idleTimeoutMillis: 45_000, connectionTimeoutMillis: 45_000 }
    : {}),
};

// ─── Pool Creation ───
function createPool(): Pool {
  const base = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '';
  const sep = base.includes('?') ? '&' : '?';
  // Append pooler-friendly params:
  //   pgbouncer=true  — tells Supabase to use the pooled port (6543)
  //   sslmode=require  — encrypted, no CA-chain verification (Supabase self-signed)
  //   uselibpqcompat=true — makes sslmode=require use libpq semantics
  const connectionString = `${base}${sep}uselibpqcompat=true&sslmode=require&pgbouncer=true`;

  const pool = new Pool({
    connectionString,
    ...POOL_CONFIG,
    ssl: process.env.NODE_ENV !== 'production'
      ? { rejectUnauthorized: false }
      : undefined,
  });

  // Surface pool errors so they don't go silent
  pool.on('error', (err) => {
    console.error('[DB-POOL] Unexpected idle client error:', err.message);
  });

  pool.on('connect', () => {
    if (process.env.NODE_ENV === 'development') {
      console.log('[DB-POOL] New client connected to pool');
    }
  });

  return pool;
}

// ─── Re-warm Lock ───
// Prevents concurrent re-warm attempts that could create connection storms.
let isRewarming = false;
let isWarming = false;

// ─── Pool Warm-up ───
// Pre-establish min connections on startup so the first request doesn't pay
// the TCP + TLS + authentication round-trip penalty.
// Cold-start aware: uses longer delays for Supabase wake-up.
let lastWarmupTime = 0;
const MIN_WARMUP_INTERVAL = 30_000; // don't re-warm more than once per 30s

async function warmPool(pool: Pool, isColdStart = false): Promise<void> {
  if (isWarming) return; // prevent concurrent warm-up
  const now = Date.now();
  if (now - lastWarmupTime < MIN_WARMUP_INTERVAL && !isColdStart) return;
  isWarming = true;
  lastWarmupTime = now;
  
  const start = performance.now();
  const maxRetries = isColdStart ? 8 : 5; // more retries for cold starts
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Force the pool to create `min` clients by checking out and releasing them
      const warmupPromises: Promise<void>[] = [];
      const connectionsToCreate = isColdStart ? 2 : (POOL_CONFIG.min || 2); // start small on cold start
      
      for (let i = 0; i < connectionsToCreate; i++) {
        warmupPromises.push(
          pool.connect().then((client) => {
            // Run a lightweight query to ensure the connection is fully initialized
            return client.query('SELECT 1').then(() => {
              client.release();
            });
          })
        );
      }
      await Promise.all(warmupPromises);
      
      // On cold start, after initial connections succeed, warm up the rest
      if (isColdStart && connectionsToCreate < (POOL_CONFIG.min || 2)) {
        const remaining = (POOL_CONFIG.min || 2) - connectionsToCreate;
        for (let i = 0; i < remaining; i++) {
          try {
            const client = await pool.connect();
            await client.query('SELECT 1');
            client.release();
          } catch { break; }
        }
      }
      
      recordActivity();
      const elapsed = (performance.now() - start).toFixed(0);
      console.log(`[DB-POOL] Warmed up ${POOL_CONFIG.min} connections in ${elapsed}ms (attempt ${attempt}${isColdStart ? ', cold start' : ''})`);
      return;
    } catch (err: any) {
      const elapsed = (performance.now() - start).toFixed(0);
      if (attempt < maxRetries) {
        // Exponential backoff with jitter: 1s, 2s, 4s, 8s... up to 15s for cold starts
        const maxDelay = isColdStart ? 15000 : 8000;
        const delay = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 500, maxDelay);
        console.warn(`[DB-POOL] Warm-up attempt ${attempt}/${maxRetries} failed after ${elapsed}ms, retrying in ${Math.round(delay)}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[DB-POOL] Warm-up failed after ${elapsed}ms (${maxRetries} attempts):`, err?.message);
      }
    }
  }
  // Don't throw — the pool will lazily connect on first real request
  isWarming = false;
}

/** Re-warm pool after cold start detection (called from isDbHealthy) */
export async function reWarmAfterColdStart(): Promise<void> {
  if (isRewarming) return; // prevent concurrent re-warm attempts
  isRewarming = true;
  
  try {
    const pool = globalForPrisma.pgPool;
    if (!pool) return;
    
    console.log(`[DB-POOL] 🔄  Re-warming pool after cold start (avg wake time: ${coldStartState.coldStartWakeTimeMs}ms)...`);
    
    // Re-warm with cold-start awareness
    await warmPool(pool, true);
  } finally {
    isRewarming = false;
  }
}

// ─── Prisma Client Creation ───
function createPrismaClient(pool: Pool): PrismaClient {
  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
}

// ─── Singleton Initialization ───
function initializePoolAndPrisma(): { prisma: PrismaClient; pool: Pool } {
  // In development, reuse the global singleton to survive HMR
  if (globalForPrisma.prisma && globalForPrisma.pgPool) {
    return { prisma: globalForPrisma.prisma, pool: globalForPrisma.pgPool };
  }

  const pool = createPool();
  const prisma = createPrismaClient(pool);

  // Store on globalThis for HMR persistence
  globalForPrisma.prisma = prisma;
  globalForPrisma.pgPool = pool;

  // Warm up the pool immediately (non-blocking)
  warmPool(pool);

  // Keep-alive: Supabase (and its pooler) closes idle connections aggressively.
  // A lightweight ping every 20s keeps the warm connections alive so requests
  // don't pay the 2-3s TCP+TLS cold-connect cost on every request burst.
  const g = globalThis as any;
  if (!g.__tirbeoPoolKeepAlive) {
    let keepAliveCount = 0;
    g.__tirbeoPoolKeepAlive = setInterval(async () => {
      keepAliveCount++;
      try {
        await globalForPrisma.pgPool?.query('SELECT 1');
        recordActivity();
        
        // Every 6 keep-alive cycles (2 min), refresh idle connections
        if (keepAliveCount % 6 === 0) {
          await refreshIdleConnections();
        }
      } catch (err: any) {
        // If keep-alive fails, it might be a cold start
        if (isColdStartError(err)) {
          recordColdStart();
          reWarmAfterColdStart().catch(() => {});
        }
      }
    }, 20_000);
  }

  return { prisma, pool };
}

export const { prisma } = initializePoolAndPrisma();

// ─── Cold Start Detection ───
// Supabase free tier databases go to sleep after ~7 minutes of inactivity.
// This module detects cold starts and proactively re-warms connections.
interface ColdStartState {
  isColdStart: boolean;
  lastActivity: number;
  lastColdStartDetected: number;
  coldStartCount: number;
  coldStartWakeTimeMs: number; // avg time to wake up
}

const g7 = globalThis as any;
if (!g7.__tirbeoColdStartState) {
  g7.__tirbeoColdStartState = {
    isColdStart: false,
    lastActivity: Date.now(),
    lastColdStartDetected: 0,
    coldStartCount: 0,
    coldStartWakeTimeMs: 0,
  };
}
const coldStartState: ColdStartState = g7.__tirbeoColdStartState;

const COLD_START_IDLE_THRESHOLD_MS = 7 * 60 * 1000; // 7 min of no activity = potential cold start (matches Supabase free tier)

/** Detect if a DB error indicates a cold start */
function isColdStartError(err: any): boolean {
  const msg = err?.message?.toLowerCase() || '';
  const code = err?.code || '';
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    msg.includes('connection refused') ||
    msg.includes('server closed the connection') ||
    msg.includes('connection timed out') ||
    msg.includes('the database system is starting up') ||
    msg.includes('terminating connection due to administrator command') ||
    msg.includes('connection terminated') ||
    msg.includes('connection reset by peer')
  );
}

/** Check if we've been idle long enough to expect a cold start */
function isIdleLongEnough(): boolean {
  return Date.now() - coldStartState.lastActivity > COLD_START_IDLE_THRESHOLD_MS;
}

/** Mark a cold start was detected and track timing */
function recordColdStart() {
  if (!coldStartState.isColdStart) {
    coldStartState.isColdStart = true;
    coldStartState.lastColdStartDetected = Date.now();
    coldStartState.coldStartCount++;
    console.warn(`[DB-COLD] ❄️  Cold start detected (#${coldStartState.coldStartCount}) — warming up connections...`);
  }
}

/** Mark that the DB is responsive again */
function recordActivity() {
  if (coldStartState.isColdStart && coldStartState.lastColdStartDetected > 0) {
    const wakeTime = Date.now() - coldStartState.lastColdStartDetected;
    coldStartState.coldStartWakeTimeMs = 
      coldStartState.coldStartWakeTimeMs === 0 ? wakeTime :
      Math.round((coldStartState.coldStartWakeTimeMs + wakeTime) / 2);
    console.log(`[DB-COLD] ✅  Database warmed up in ${wakeTime}ms (avg: ${coldStartState.coldStartWakeTimeMs}ms)`);
    coldStartState.isColdStart = false;
  }
  coldStartState.lastActivity = Date.now();
}

/** Get cold start state for diagnostics */
export function getColdStartState() {
  return { ...coldStartState };
}

// ─── Retry wrapper for database queries ───
// Handles transient connection failures with exponential backoff + jitter.
// Cold-start aware: detects Supabase wake-up scenarios and retries longer.
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 500
): Promise<T> {
  let lastError: any;
  const startTime = performance.now();
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      recordActivity();
      return result;
    } catch (err: any) {
      lastError = err;
      
      const isColdStart = isColdStartError(err);
      const isRetryable = isColdStart ||
        err?.message?.includes('timeout') ||
        err?.message?.includes('pool') ||
        err?.message?.includes('too many clients') ||
        err?.code === '57P01' || // pg_terminate_backend
        err?.code === '57P02' || // pg_cancel_backend
        err?.code === '08006' || // connection_failure
        err?.code === '08001' || // sqlclient_unable_to_establish_sqlconnection
        err?.code === '08003' || // connection_does_not_exist
        err?.code === '08004' || // sqlserver_rejected_establishment
        err?.code === '53300';    // too_many_connections
      
      if (isColdStart) {
        recordColdStart();
      }
      
      if (isRetryable && attempt < maxRetries) {
        // Exponential backoff with jitter to avoid thundering herd
        // Cold starts use longer delays (DB needs time to wake)
        const delayMultiplier = isColdStart ? 3 : 1;
        const baseCalc = baseDelay * Math.pow(2, attempt) * delayMultiplier;
        const jitter = Math.random() * baseCalc * 0.3; // 0-30% jitter
        const delay = Math.min(baseCalc + jitter, isColdStart ? 15000 : 5000);
        
        console.warn(`[DB-RETRY] Query failed (attempt ${attempt + 1}/${maxRetries + 1}), ` +
          `retrying in ${Math.round(delay)}ms... ${isColdStart ? '(cold start)' : ''}`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

// ─── Connection Refresh ───
// Proactively refresh idle connections to prevent Supabase's aggressive idle timeout.
const g8 = globalThis as any;
if (!g8.__tirbeoLastRefreshTime) g8.__tirbeoLastRefreshTime = 0;
const CONNECTION_REFRESH_INTERVAL = 4 * 60 * 1000; // refresh every 4 min (before Supabase's 5 min idle timeout)

async function refreshIdleConnections() {
  const pool = globalForPrisma.pgPool;
  if (!pool) return;
  
  const now = Date.now();
  const gRefresh = globalThis as any;
  if (now - (gRefresh.__tirbeoLastRefreshTime || 0) < CONNECTION_REFRESH_INTERVAL) return;
  gRefresh.__tirbeoLastRefreshTime = now;
  
  try {
    // Rotate out old idle connections by running a lightweight query on each idle client
    const idleCount = pool.idleCount;
    if (idleCount <= 0) return;
    
    const refreshPromises: Promise<void>[] = [];
    for (let i = 0; i < Math.min(idleCount, 3); i++) { // refresh max 3 at a time
      refreshPromises.push(
        pool.connect().then(client => {
          return client.query('SELECT 1').then(() => {
            client.release();
          }).catch(() => {
            client.release(true); // destroy on error
          });
        }).catch(() => {})
      );
    }
    await Promise.all(refreshPromises);
    if (process.env.NODE_ENV === 'development') {
      console.log(`[DB-POOL] Refreshed ${Math.min(idleCount, 3)} idle connections`);
    }
  } catch {
    // Silently ignore refresh errors
  }
}



// ─── Pool Exhaustion Alerting ───
// Monitors waitingCount and alerts when connections are exhausted.
interface PoolAlertState {
  waitingSince: number | null;  // timestamp when waitingCount first became > 0
  lastAlertAt: number | null;   // timestamp of last alert
  alertCount: number;           // total alerts fired
  lastWarningAt: number | null;
  lastCriticalAt: number | null;
}

const poolAlertState: PoolAlertState = {
  waitingSince: null,
  lastAlertAt: null,
  alertCount: 0,
  lastWarningAt: null,
  lastCriticalAt: null,
};

const POOL_WARN_MS = 10_000;   // warn after 10s of waiting
const POOL_CRIT_MS = 30_000;   // critical after 30s of waiting
const POOL_CHECK_INTERVAL = 5_000; // check every 5s

function monitorPool() {
  const pool = globalForPrisma.pgPool;
  if (!pool) return;

  const waiting = pool.waitingCount;
  const total = pool.totalCount;
  const idle = pool.idleCount;
  const max = pool.options.max || 5;

  if (waiting > 0) {
    // Waiting clients detected
    if (!poolAlertState.waitingSince) {
      poolAlertState.waitingSince = Date.now();
      console.warn(`[DB-POOL-ALERT] Pool exhaustion started — waiting: ${waiting}, total: ${total}, idle: ${idle}, max: ${max}`);
    }

    const waitDuration = Date.now() - poolAlertState.waitingSince;

    // Warning threshold
    if (waitDuration >= POOL_WARN_MS && (!poolAlertState.lastWarningAt || Date.now() - poolAlertState.lastWarningAt > 60_000)) {
      poolAlertState.lastWarningAt = Date.now();
      poolAlertState.alertCount++;
      console.warn(`[DB-POOL-ALERT] ⚠️  WARNING: Pool exhaustion for ${Math.round(waitDuration / 1000)}s — waiting: ${waiting}, total: ${total}/${max}, idle: ${idle}`);
    }

    // Critical threshold
    if (waitDuration >= POOL_CRIT_MS && (!poolAlertState.lastCriticalAt || Date.now() - poolAlertState.lastCriticalAt > 60_000)) {
      poolAlertState.lastCriticalAt = Date.now();
      poolAlertState.alertCount++;
      console.error(`[DB-POOL-ALERT] 🔴 CRITICAL: Pool exhaustion for ${Math.round(waitDuration / 1000)}s — waiting: ${waiting}, total: ${total}/${max}, idle: ${idle}`);
    }

    poolAlertState.lastAlertAt = Date.now();
  } else {
    // No waiting clients — reset if we were in exhaustion
    if (poolAlertState.waitingSince) {
      const duration = Date.now() - poolAlertState.waitingSince;
      console.log(`[DB-POOL-ALERT] ✅ Pool exhaustion resolved after ${Math.round(duration / 1000)}s`);
      poolAlertState.waitingSince = null;
    }
  }
}

// Start monitoring in production and development
if (typeof setInterval !== 'undefined') {
  setInterval(monitorPool, POOL_CHECK_INTERVAL);
}

export function getPoolAlertState() {
  return {
    ...poolAlertState,
    waitingDurationMs: poolAlertState.waitingSince ? Date.now() - poolAlertState.waitingSince : 0,
    isExhausted: poolAlertState.waitingSince !== null,
    thresholds: { warnMs: POOL_WARN_MS, critMs: POOL_CRIT_MS },
  };
}

// ─── Health Check ───
export async function checkDatabaseConnection(): Promise<{
  ok: boolean;
  latencyMs: number;
  poolStats: { idle: number; waiting: number; total: number };
  isColdStart?: boolean;
}> {
  const start = performance.now();
  try {
    await withRetry(() => prisma.$queryRaw`SELECT 1`, 2, 300);
    recordActivity();
    const latencyMs = performance.now() - start;
    const pool = globalForPrisma.pgPool;
    return {
      ok: true,
      latencyMs: Math.round(latencyMs),
      poolStats: {
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        total: pool.totalCount,
      },
    };
  } catch (err: any) {
    const latencyMs = performance.now() - start;
    
    // Detect cold start and trigger reconnection
    if (isColdStartError(err) && isIdleLongEnough()) {
      recordColdStart();
      reWarmAfterColdStart().catch(() => {});
    }
    
    return {
      ok: false,
      latencyMs: Math.round(latencyMs),
      poolStats: { idle: 0, waiting: 0, total: 0 },
      isColdStart: isColdStartError(err),
    };
  }
}

// ─── Pool Status (for monitoring/debugging) ───
export function getPoolStatus() {
  const pool = globalForPrisma.pgPool;
  if (!pool) return null;
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}

// ─── Detailed Pool Metrics (for /api/health/pool) ───
let poolCreated_at = Date.now();

export function getDetailedPoolStatus() {
  const pool = globalForPrisma.pgPool;
  if (!pool) return null;

  return {
    // Current state
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,

    // Configuration
    config: {
      max: pool.options.max,
      min: pool.options.min,
      idleTimeoutMillis: pool.options.idleTimeoutMillis,
      connectionTimeoutMillis: pool.options.connectionTimeoutMillis,
    },

    // Utilization metrics
    utilization: {
      activeConnections: pool.totalCount - pool.idleCount,
      utilizationPercent: pool.totalCount > 0
        ? Math.round(((pool.totalCount - pool.idleCount) / pool.totalCount) * 100)
        : 0,
      saturationPercent: pool.options.max && pool.options.max > 0
        ? Math.round((pool.waitingCount / pool.options.max) * 100)
        : 0,
    },

    // Health indicators
    health: {
      hasWaitingClients: pool.waitingCount > 0,
      isNearMaxCapacity: pool.options.max ? pool.totalCount >= pool.options.max * 0.8 : false,
      idleRatio: pool.totalCount > 0
        ? Math.round((pool.idleCount / pool.totalCount) * 100)
        : 100,
    },

  // Cold start state
  coldStart: {
    isColdStart: coldStartState.isColdStart,
    coldStartCount: coldStartState.coldStartCount,
    avgWakeTimeMs: coldStartState.coldStartWakeTimeMs,
    lastColdStartAt: coldStartState.lastColdStartDetected
      ? new Date(coldStartState.lastColdStartDetected).toISOString()
      : null,
    idleThresholdMs: COLD_START_IDLE_THRESHOLD_MS,
  },

  // Uptime
  uptimeMs: Date.now() - poolCreated_at,
  uptimeFormatted: formatUptime(Date.now() - poolCreated_at),

  // Memory (approximate from Node.js process)
    memory: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  };
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// ─── Performance Monitoring Wrapper ───
export async function withPerformanceLogging<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    const duration = performance.now() - start;
    if (duration > 1000) {
      console.warn(`[PERF] ${operation} took ${duration.toFixed(0)}ms`);
    }
    return result;
  } catch (error) {
    const duration = performance.now() - start;
    console.error(`[PERF] ${operation} failed after ${duration.toFixed(0)}ms`);
    throw error;
  }
}

// ─── Batch Query Helper ───
export async function batchQueries<T extends Record<string, Promise<any>>>(
  queries: T
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(queries);
  const results = await Promise.all(keys.map(k => queries[k]));
  return keys.reduce((acc, key, index) => {
    acc[key] = results[index];
    return acc;
  }, {} as any);
}

// ─── Graceful Shutdown ───
// Graceful shutdown disabled in development to prevent pool kills during HMR.
// In production, SIGTERM/SIGINT handlers are registered by the process manager.
if (process.env.NODE_ENV === 'production') {
  let isShuttingDown = false;
  async function gracefulShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('[SHUTDOWN] Graceful shutdown initiated');
    const pool = globalForPrisma.pgPool;
    const prisma = globalForPrisma.prisma;
    try { await prisma.$disconnect(); } catch {}
    try { if (pool) await pool.end(); } catch {}
    process.exit(0);
  }
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

// ─── Fast DB Health Cache ───
// Cached DB status used by the route handler to short-circuit requests when DB is down.
// Avoids running a full query on every request — only checks every N seconds.
interface DbHealthCache {
  ok: boolean;
  lastCheck: number;
  consecutiveFailures: number;
  lastError: string;
}

const g6 = globalThis as any;
if (!g6.__tirbeoDbHealthCache) {
  g6.__tirbeoDbHealthCache = {
    ok: true,
    lastCheck: 0,
    consecutiveFailures: 0,
    lastError: '',
  };
}
const dbHealthCache: DbHealthCache = g6.__tirbeoDbHealthCache;

const DB_HEALTH_CHECK_INTERVAL = 10_000; // check every 10s
const DB_HEALTH_FAIL_THRESHOLD = 3; // consider DB down after 3 consecutive failures

/** Fast cached DB health check — returns immediately if recently checked */
export async function isDbHealthy(): Promise<boolean> {
  const now = Date.now();
  if (now - dbHealthCache.lastCheck < DB_HEALTH_CHECK_INTERVAL) {
    return dbHealthCache.ok;
  }

  try {
    await withRetry(() => prisma.$queryRaw`SELECT 1`, 1, 100);
    dbHealthCache.ok = true;
    dbHealthCache.consecutiveFailures = 0;
    dbHealthCache.lastError = '';
    dbHealthCache.lastCheck = now;
    return true;
  } catch (err: any) {
    dbHealthCache.consecutiveFailures++;
    dbHealthCache.lastError = err?.message || 'Unknown DB error';
    dbHealthCache.lastCheck = now;
    
    // Detect cold start scenario
    if (isColdStartError(err) && isIdleLongEnough()) {
      recordColdStart();
      // Trigger proactive reconnection in background
      reWarmAfterColdStart().catch(() => {});
    }
    
    // Only mark DB as down after consecutive failures to avoid false positives
    if (dbHealthCache.consecutiveFailures >= DB_HEALTH_FAIL_THRESHOLD) {
      dbHealthCache.ok = false;
      console.error(`[DB-HEALTH] Database marked as DOWN after ${dbHealthCache.consecutiveFailures} consecutive failures: ${dbHealthCache.lastError}`);
    }
    return false;
  }
}

/** Get current DB health status for diagnostics */
export function getDbHealthStatus() {
  return { ...dbHealthCache };
}

/** Force-reset DB health status (e.g. after manual intervention) */
export function resetDbHealth() {
  dbHealthCache.ok = true;
  dbHealthCache.consecutiveFailures = 0;
  dbHealthCache.lastCheck = 0;
  dbHealthCache.lastError = '';
}

/** Wrapper that catches DB errors and returns a 503 response */
export function dbErrorResponse(error?: string) {
  return new Response(
    JSON.stringify({
      error: 'Service temporarily unavailable',
      message: error || 'Database connection is currently unavailable. Please try again later.',
      code: 'DATABASE_UNAVAILABLE',
      retryAfter: 30,
    }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '30',
        'Cache-Control': 'no-store',
      },
    }
  );
}
