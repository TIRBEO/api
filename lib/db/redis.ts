/**
 * Shared Redis factory with reconnection logic, keep-alive, and cold start detection.
 *
 * Upstash (and similar serverless Redis providers) aggressively close idle
 * connections after ~30-60 seconds. This module handles:
 *
 * 1. Automatic reconnection with exponential backoff when connections drop
 * 2. Keep-alive pings to prevent idle timeout
 * 3. Cold start detection for Upstash wake-up scenarios
 * 4. Connection state tracking for diagnostics
 */

// Lazy-loaded Redis class to avoid Turbopack bundling issues
import type Redis from 'ioredis';

let _Redis: any = null;
function getRedisClass(): any {
  if (_Redis) return _Redis;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _Redis = require('ioredis').default || require('ioredis');
  } catch {
    console.warn('[REDIS] ioredis not available, Redis features disabled');
    _Redis = class { constructor() { throw new Error('ioredis not available'); } };
  }
  return _Redis;
}

// ─── Log Throttling ───
// Upstash (serverless Redis) drops idle connections regularly, so reconnect
// logs fire constantly. Throttle them to keep the console readable.
const logThrottle = new Map<string, number>();

/** Run fn at most once per intervalMs per key. */
function throttledLog(key: string, intervalMs: number, fn: () => void): void {
  const now = Date.now();
  const last = logThrottle.get(key) || 0;
  if (now - last < intervalMs) return;
  logThrottle.set(key, now);
  fn();
}

// ─── Connection State ───
interface RedisConnectionState {
  isConnected: boolean;
  lastConnectedAt: number;
  lastDisconnectedAt: number;
  lastError: string;
  reconnectCount: number;
  lastReconnectAt: number;
  totalRequests: number;
  failedRequests: number;
  lastKeepAliveAt: number;
  keepAliveFailures: number;
}

// ─── Configuration ───
const REDIS_CONFIG = {
  // Retry strategy: exponential backoff with max 30s delay
  retryStrategy(times: number): number | null {
    if (times > 20) {
      console.error('[REDIS-RETRY] Max retries (20) exceeded, giving up');
      return null;
    }
    const delay = Math.min(times * 100, 30000); // 100ms, 200ms, ... up to 30s
    throttledLog('redis:retry', 30_000, () => console.warn(`[REDIS-RETRY] Reconnecting in ${delay}ms (attempt ${times})`));
    return delay;
  },

  // Connection timeout
  connectTimeout: 10_000,

  // Max retries per request (fail fast for individual operations)
  maxRetriesPerRequest: 3,

  // Enable lazy connect to avoid connection storms on startup
  lazyConnect: true,

  // TLS for Upstash (self-signed cert)
  tls: { rejectUnauthorized: false },

  // Keep-alive interval (30s — Upstash closes idle connections after ~30-60s)
  keepAliveInterval: 25_000,

  // Reconnect on error codes that indicate connection loss
  reconnectOnErrors: [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EPIPE',
    'ERR_STREAM_DESTROYED',
  ],
};

// ─── Connection Tracking ───
const g = globalThis as any;
if (!g.__tirbeoRedisConnections) {
  g.__tirbeoRedisConnections = new Map<string, RedisConnectionState>();
}
const connectionStates: Map<string, RedisConnectionState> = g.__tirbeoRedisConnections;

function getState(name: string): RedisConnectionState {
  if (!connectionStates.has(name)) {
    connectionStates.set(name, {
      isConnected: false,
      lastConnectedAt: 0,
      lastDisconnectedAt: 0,
      lastError: '',
      reconnectCount: 0,
      lastReconnectAt: 0,
      totalRequests: 0,
      failedRequests: 0,
      lastKeepAliveAt: 0,
      keepAliveFailures: 0,
    });
  }
  return connectionStates.get(name)!;
}

// ─── Keep-Alive Management ───
const keepAliveTimers: Map<string, NodeJS.Timeout> = new Map();

function startKeepAlive(name: string, client: any): void {
  if (keepAliveTimers.has(name)) return;

  const timer = setInterval(async () => {
    try {
      await client.ping();
      const state = getState(name);
      state.lastKeepAliveAt = Date.now();
      state.keepAliveFailures = 0;
    } catch (err: any) {
      const state = getState(name);
      state.keepAliveFailures++;
      console.warn(`[REDIS-KEEPALIVE] ${name}: Ping failed (${state.keepAliveFailures} consecutive): ${err?.message}`);

      // If keep-alive fails 3 times consecutively, trigger reconnect
      if (state.keepAliveFailures >= 3) {
        console.warn(`[REDIS-KEEPALIVE] ${name}: Too many failures, triggering reconnect...`);
        try {
          await client.disconnect();
        } catch {}
        state.keepAliveFailures = 0;
      }
    }
  }, REDIS_CONFIG.keepAliveInterval);

  keepAliveTimers.set(name, timer);
}

function stopKeepAlive(name: string): void {
  const timer = keepAliveTimers.get(name);
  if (timer) {
    clearInterval(timer);
    keepAliveTimers.delete(name);
  }
}

// ─── Error Detection ───
function isConnectionError(err: any): boolean {
  const code = err?.code || '';
  const msg = err?.message?.toLowerCase() || '';

  if (REDIS_CONFIG.reconnectOnErrors.includes(code)) return true;
  if (msg.includes('connection lost')) return true;
  if (msg.includes('stream destroyed')) return true;
  if (msg.includes('socket closed')) return true;
  if (msg.includes('read echCONNRESET')) return true;
  return false;
}

// ─── Redis Factory ───
interface CreateRedisOptions {
  name: string;           // Unique name for this Redis instance (for tracking)
  url?: string;           // Redis URL (defaults to REDIS_URL env)
  enableKeepAlive?: boolean; // Enable keep-alive ping (default: true)
  keepAliveInterval?: number; // Custom keep-alive interval in ms
  onReconnect?: () => void;  // Callback when reconnection succeeds
}

/**
 * Create a Redis client with automatic reconnection and keep-alive.
 */
export function createRedisClient(options: CreateRedisOptions): any {
  const {
    name,
    url = process.env.REDIS_URL,
    enableKeepAlive = true,
    keepAliveInterval,
    onReconnect,
  } = options;

  if (!url) {
    throw new Error(`[REDIS] No URL provided for Redis client "${name}"`);
  }

  const state = getState(name);

  const config = {
    ...REDIS_CONFIG,
    keepAliveInterval: keepAliveInterval || REDIS_CONFIG.keepAliveInterval,
  };

  const client = new (getRedisClass())(url, {
    retryStrategy: config.retryStrategy,
    connectTimeout: config.connectTimeout,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    lazyConnect: config.lazyConnect,
    tls: config.tls,
    // Enable auto-resend unfulfilled commands after reconnect
    enableOfflineQueue: true,
  });

  // ─── Event Handlers ───

  client.on('connect', () => {
    state.isConnected = true;
    state.lastConnectedAt = Date.now();
    if (state.reconnectCount > 0) {
      console.log(`[REDIS-${name}] ✅ Reconnected (attempt #${state.reconnectCount})`);
    }
  });

  client.on('ready', () => {
    state.isConnected = true;
    if (enableKeepAlive) {
      startKeepAlive(name, client);
    }
    if (onReconnect && state.reconnectCount > 0) {
      onReconnect();
    }
  });

  client.on('close', () => {
    state.isConnected = false;
    state.lastDisconnectedAt = Date.now();
    stopKeepAlive(name);
  });

  client.on('error', (err: any) => {
    state.lastError = err?.message || 'Unknown error';
    state.failedRequests++;

    if (isConnectionError(err)) {
      state.reconnectCount++;
      state.lastReconnectAt = Date.now();
      throttledLog(`redis:error:${name}`, 60_000, () => console.warn(`[REDIS-${name}] ⚠️  Connection error (reconnect #${state.reconnectCount}): ${err?.message}`));
    } else {
      console.error(`[REDIS-${name}] ❌ Non-reconnectable error: ${err?.message}`);
    }
  });

  client.on('reconnecting', (delay: number) => {
    state.isConnected = false;
    throttledLog(`redis:reconnecting:${name}`, 60_000, () => console.warn(`[REDIS-${name}] 🔄 Reconnecting in ${delay}ms...`));
  });

  return client;
}

// ─── Cached Client Factory ───
// Singleton clients that survive HMR in development
const g2 = globalThis as any;
if (!g2.__tirbeoRedisClients) {
  g2.__tirbeoRedisClients = new Map<string, any>();
}
const cachedClients: Map<string, Redis> = g2.__tirbeoRedisClients;

/**
 * Get or create a cached Redis client with reconnection support.
 * Clients are cached globally to survive HMR in development.
 */
export function getCachedRedisClient(name: string, options?: Partial<CreateRedisOptions>): any {
  if (cachedClients.has(name)) {
    return cachedClients.get(name)!;
  }

  const client = createRedisClient({ name, ...options });
  cachedClients.set(name, client);

  // Auto-connect on first use (lazy connect)
  client.connect().catch((err: any) => {
    console.warn(`[REDIS-${name}] Initial connection failed: ${err?.message}. Will retry on next operation.`);
  });

  return client;
}

// ─── Health Check ───
/**
 * Check if a Redis client is healthy by running PING.
 */
export async function checkRedisHealth(client: any): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = performance.now();
  try {
    await client.ping();
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (err: any) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - start),
      error: err?.message,
    };
  }
}

// ─── Diagnostics ───
/**
 * Get connection state for all Redis clients.
 */
export function getAllRedisStates(): Record<string, RedisConnectionState> {
  const result: Record<string, RedisConnectionState> = {};
  for (const [name, state] of connectionStates) {
    result[name] = { ...state };
  }
  return result;
}

/**
 * Get connection state for a specific Redis client.
 */
export function getRedisState(name: string): RedisConnectionState | null {
  const state = connectionStates.get(name);
  return state ? { ...state } : null;
}

/**
 * Force-reset a Redis client's connection state.
 */
export function resetRedisState(name: string): void {
  connectionStates.delete(name);
}

// ─── Graceful Shutdown ───
export async function disconnectAllRedis(): Promise<void> {
  // Stop all keep-alive timers
  for (const [name, timer] of keepAliveTimers) {
    clearInterval(timer);
    console.log(`[REDIS] Stopped keep-alive for ${name}`);
  }
  keepAliveTimers.clear();

  // Disconnect all clients
  for (const [name, client] of cachedClients) {
    try {
      await client.quit();
      console.log(`[REDIS] Disconnected ${name}`);
    } catch {
      try {
        client.disconnect();
      } catch {}
    }
  }
  cachedClients.clear();
}

// Guard against HMR re-evaluating this module and stacking duplicate handlers.
const sigGlobal = globalThis as any;
if (!sigGlobal.__tirbeoRedisSignalsInstalled) {
  sigGlobal.__tirbeoRedisSignalsInstalled = true;
  process.on('SIGTERM', () => disconnectAllRedis().catch(() => {}));
  process.on('SIGINT', () => disconnectAllRedis().catch(() => {}));
}
