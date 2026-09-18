/**
 * Query Performance Monitor
 * 
 * Tracks latency distributions for key queries that benefit from the
 * performance indexes added in migration 20260825000000_add_performance_indexes.
 * 
 * Includes configurable P95 latency alerts that notify admins when
 * queries exceed performance thresholds.
 * 
 * Used by /api/debug/query-perf to surface before/after metrics.
 */

interface QueryStats {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  recentSamples: number[]; // last N latencies for trend analysis
  lastUpdated: number;
}

export interface LatencyAlert {
  queryName: string;
  p95Ms: number;
  thresholdMs: number;
  severity: 'warning' | 'critical';
  firedAt: number;
  message: string;
}

interface AlertConfig {
  /** P95 latency (ms) above which a warning fires */
  warningThresholdMs: number;
  /** P95 latency (ms) above which a critical alert fires */
  criticalThresholdMs: number;
  /** Minimum number of samples before alerts can fire */
  minSamples: number;
  /** Cooldown between alerts for the same query (ms) */
  cooldownMs: number;
}

const MAX_SAMPLES = 200;
const MAX_TRACKED_QUERIES = 50;
const MAX_ALERT_HISTORY = 100;

// ─── Configurable thresholds ─────────────────────────────────────
// Defaults tuned for PostgreSQL on Supabase free tier.
// Override via environment variables or updateAlertConfig().
let alertConfig: AlertConfig = {
  warningThresholdMs: Number(process.env.QUERY_PERF_WARNING_MS) || 200,
  criticalThresholdMs: Number(process.env.QUERY_PERF_CRITICAL_MS) || 1000,
  minSamples: Number(process.env.QUERY_PERF_MIN_SAMPLES) || 5,
  cooldownMs: Number(process.env.QUERY_PERF_COOLDOWN_MS) || 300_000, // 5 min
};

// ─── State ───────────────────────────────────────────────────────
const queryStore = new Map<string, number[]>();
const alertHistory: LatencyAlert[] = [];
const alertLastFired = new Map<string, number>(); // queryName → timestamp
let alertCallback: ((alert: LatencyAlert) => Promise<void>) | null = null;

/**
 * Set a callback function that fires when a latency alert triggers.
 * Use this to integrate with notification systems (email, Slack, etc.)
 */
export function onLatencyAlert(callback: (alert: LatencyAlert) => Promise<void>) {
  alertCallback = callback;
}

/**
 * Update alert thresholds at runtime.
 * Can also be set via environment variables:
 *   QUERY_PERF_WARNING_MS=200
 *   QUERY_PERF_CRITICAL_MS=1000
 *   QUERY_PERF_MIN_SAMPLES=5
 *   QUERY_PERF_COOLDOWN_MS=300000
 */
export function updateAlertConfig(config: Partial<AlertConfig>) {
  alertConfig = { ...alertConfig, ...config };
  console.log(`[QUERY-PERF] Alert config updated: warning=${alertConfig.warningThresholdMs}ms, critical=${alertConfig.criticalThresholdMs}ms, cooldown=${alertConfig.cooldownMs / 1000}s`);
}

/** Get current alert config */
export function getAlertConfig(): AlertConfig {
  return { ...alertConfig };
}

// ─── Recording ───────────────────────────────────────────────────

/**
 * Record a query execution time and check against alert thresholds.
 * Call this after each index-backed query completes.
 */
export function recordQueryLatency(queryName: string, durationMs: number) {
  let samples = queryStore.get(queryName);
  if (!samples) {
    if (queryStore.size >= MAX_TRACKED_QUERIES) return;
    samples = [];
    queryStore.set(queryName, samples);
  }
  samples.push(durationMs);
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }

  // Check alerts after recording
  checkAlerts(queryName, samples);
}

/**
 * Wrapper that times a query function and records its latency.
 * Usage: const results = await trackQuery('security_events_by_user', () => prisma.securityEvent.findMany(...));
 */
export async function trackQuery<T>(queryName: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    recordQueryLatency(queryName, performance.now() - start);
    return result;
  } catch (err) {
    recordQueryLatency(queryName, performance.now() - start);
    throw err;
  }
}

// ─── Alert Logic ─────────────────────────────────────────────────

function checkAlerts(queryName: string, samples: number[]) {
  if (samples.length < alertConfig.minSamples) return;

  // Compute P95 from sorted samples
  const sorted = [...samples].sort((a, b) => a - b);
  const p95Ms = sorted[Math.floor(sorted.length * 0.95)] || 0;

  // Determine severity
  let severity: 'warning' | 'critical' | null = null;
  let thresholdMs = 0;
  if (p95Ms >= alertConfig.criticalThresholdMs) {
    severity = 'critical';
    thresholdMs = alertConfig.criticalThresholdMs;
  } else if (p95Ms >= alertConfig.warningThresholdMs) {
    severity = 'warning';
    thresholdMs = alertConfig.warningThresholdMs;
  }

  if (!severity) return;

  // Throttle: check cooldown
  const lastFired = alertLastFired.get(queryName) || 0;
  if (Date.now() - lastFired < alertConfig.cooldownMs) return;

  // Fire alert
  const alert: LatencyAlert = {
    queryName,
    p95Ms: Math.round(p95Ms * 100) / 100,
    thresholdMs,
    severity,
    firedAt: Date.now(),
    message: `[QUERY-PERF ${severity.toUpperCase()}] ${queryName}: P95=${Math.round(p95Ms)}ms exceeds ${severity} threshold of ${thresholdMs}ms`,
  };

  alertLastFired.set(queryName, Date.now());
  alertHistory.push(alert);
  if (alertHistory.length > MAX_ALERT_HISTORY) {
    alertHistory.splice(0, alertHistory.length - MAX_ALERT_HISTORY);
  }

  // Log
  if (severity === 'critical') {
    console.error(alert.message);
  } else {
    console.warn(alert.message);
  }

  // Fire callback (non-blocking)
  if (alertCallback) {
    alertCallback(alert).catch((err) => {
      console.error('[QUERY-PERF] Alert callback failed:', err?.message || err);
    });
  }
}

// ─── Stats ───────────────────────────────────────────────────────

/** Compute stats from a sorted array of samples */
function computeStats(samples: number[]): QueryStats {
  if (samples.length === 0) {
    return { count: 0, totalMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, recentSamples: [], lastUpdated: 0 };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const totalMs = sorted.reduce((sum, v) => sum + v, 0);

  return {
    count,
    totalMs: Math.round(totalMs * 100) / 100,
    minMs: Math.round(sorted[0] * 100) / 100,
    maxMs: Math.round(sorted[count - 1] * 100) / 100,
    p50Ms: Math.round(sorted[Math.floor(count * 0.5)] * 100) / 100,
    p95Ms: Math.round(sorted[Math.floor(count * 0.95)] * 100) / 100,
    p99Ms: Math.round(sorted[Math.floor(count * 0.99)] * 100) / 100,
    recentSamples: samples.slice(-20).map(v => Math.round(v * 100) / 100),
    lastUpdated: Date.now(),
  };
}

/** Get performance stats for all tracked queries */
export function getQueryPerformanceStats() {
  const queries: Record<string, QueryStats> = {};

  for (const [name, samples] of queryStore.entries()) {
    queries[name] = computeStats(samples);
  }

  // Categorize by the indexes they use
  const categories = {
    'security_events': [] as string[],
    'tickets': [] as string[],
    'notifications': [] as string[],
    'login_history': [] as string[],
    'form_submissions': [] as string[],
    'other': [] as string[],
  };

  for (const name of queryStore.keys()) {
    if (name.startsWith('security_events')) categories.security_events.push(name);
    else if (name.startsWith('tickets')) categories.tickets.push(name);
    else if (name.startsWith('notifications')) categories.notifications.push(name);
    else if (name.startsWith('login_history')) categories.login_history.push(name);
    else if (name.startsWith('form_submissions')) categories.form_submissions.push(name);
    else categories.other.push(name);
  }

  return {
    timestamp: new Date().toISOString(),
    totalTrackedQueries: queryStore.size,
    totalSamples: Array.from(queryStore.values()).reduce((sum, s) => sum + s.length, 0),
    categories,
    queries,
    alerts: getAlertState(),
  };
}

/** Get current alert state */
export function getAlertState() {
  const recentAlerts = alertHistory.slice(-20);
  const activeWarnings: string[] = [];
  const activeCriticals: string[] = [];

  // Find queries currently exceeding thresholds
  for (const [name, samples] of queryStore.entries()) {
    if (samples.length < alertConfig.minSamples) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    if (p95 >= alertConfig.criticalThresholdMs) activeCriticals.push(name);
    else if (p95 >= alertConfig.warningThresholdMs) activeWarnings.push(name);
  }

  return {
    config: alertConfig,
    recentAlerts: recentAlerts.map(a => ({
      ...a,
      firedAtFormatted: new Date(a.firedAt).toISOString(),
    })),
    activeWarnings,
    activeCriticals,
    totalAlertsFired: alertHistory.length,
  };
}

/** Reset all tracked query stats and alert history */
export function resetQueryStats() {
  queryStore.clear();
  alertHistory.length = 0;
  alertLastFired.clear();
}

/**
 * Get a human-readable summary of query performance.
 * Useful for logging and dashboards.
 */
export function getQueryPerformanceSummary(): string {
  const stats = getQueryPerformanceStats();
  const lines: string[] = ['[QUERY-PERF] Performance Summary:'];

  for (const [name, q] of Object.entries(stats.queries)) {
    if (q.count === 0) continue;
    const avgMs = (q.totalMs / q.count).toFixed(1);
    lines.push(
      `  ${name}: ${q.count} queries, avg=${avgMs}ms, p50=${q.p50Ms}ms, p95=${q.p95Ms}ms, p99=${q.p99Ms}ms`
    );
  }

  const alertState = stats.alerts;
  if (alertState.activeCriticals.length > 0) {
    lines.push(`\n  ⚠️  CRITICAL: ${alertState.activeCriticals.join(', ')}`);
  }
  if (alertState.activeWarnings.length > 0) {
    lines.push(`\n  ⚡ WARNING: ${alertState.activeWarnings.join(', ')}`);
  }

  return lines.join('\n');
}
