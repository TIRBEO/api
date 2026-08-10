import { recordRateLimitHit } from './suspicious-activity';

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 30;
const AUTH_MAX = 5;

// ─── Rate Limit Metrics ───
interface RateLimitMetrics {
  totalHits: number;
  totalBlocked: number;
  totalBypassed: number;
  hitsByIp: Map<string, { count: number; blocked: number; lastSeen: number }>;
  hitsByRoute: Map<string, { count: number; blocked: number }>;
  recentBlocks: Array<{ ip: string; route: string; timestamp: number }>;
  recentBypasses: Array<{ ip: string; route: string; userId: string; timestamp: number }>;
  windowStart: number;
}

const g4 = globalThis as any;
if (!g4.__tirbeoRateLimitMetrics) {
  g4.__tirbeoRateLimitMetrics = {
    totalHits: 0,
    totalBlocked: 0,
    totalBypassed: 0,
    hitsByIp: new Map(),
    hitsByRoute: new Map(),
    recentBlocks: [],
    recentBypasses: [],
    windowStart: Date.now(),
  };
}
const metrics: RateLimitMetrics = g4.__tirbeoRateLimitMetrics;

const MAX_RECENT_BLOCKS = 100;
const MAX_RECENT_BYPASSES = 100;
const METRICS_WINDOW_MS = 60 * 60 * 1000; // 1 hour window

function recordMetrics(ip: string, route: string, blocked: boolean): void {
  metrics.totalHits++;
  
  // Reset metrics if window expired
  if (Date.now() - metrics.windowStart > METRICS_WINDOW_MS) {
    metrics.totalHits = 0;
    metrics.totalBlocked = 0;
    metrics.hitsByIp.clear();
    metrics.hitsByRoute.clear();
    metrics.recentBlocks = [];
    metrics.windowStart = Date.now();
  }
  
  // Track by IP
  const ipEntry = metrics.hitsByIp.get(ip) || { count: 0, blocked: 0, lastSeen: 0 };
  ipEntry.count++;
  if (blocked) ipEntry.blocked++;
  ipEntry.lastSeen = Date.now();
  metrics.hitsByIp.set(ip, ipEntry);
  
  // Track by route
  const routeKey = route.split('?')[0]; // Remove query params
  const routeEntry = metrics.hitsByRoute.get(routeKey) || { count: 0, blocked: 0 };
  routeEntry.count++;
  if (blocked) routeEntry.blocked++;
  metrics.hitsByRoute.set(routeKey, routeEntry);
  
  // Record blocked events
  if (blocked) {
    metrics.totalBlocked++;
    metrics.recentBlocks.unshift({ ip, route: routeKey, timestamp: Date.now() });
    if (metrics.recentBlocks.length > MAX_RECENT_BLOCKS) {
      metrics.recentBlocks.pop();
    }
  }
}

export function recordBypass(ip: string, route: string, userId: string): void {
  metrics.totalBypassed++;
  
  // Reset metrics if window expired
  if (Date.now() - metrics.windowStart > METRICS_WINDOW_MS) {
    metrics.totalHits = 0;
    metrics.totalBlocked = 0;
    metrics.totalBypassed = 0;
    metrics.hitsByIp.clear();
    metrics.hitsByRoute.clear();
    metrics.recentBlocks = [];
    metrics.recentBypasses = [];
    metrics.windowStart = Date.now();
  }
  
  metrics.recentBypasses.unshift({ ip, route: route.split('?')[0], userId, timestamp: Date.now() });
  if (metrics.recentBypasses.length > MAX_RECENT_BYPASSES) {
    metrics.recentBypasses.pop();
  }
}

export function getRateLimitMetrics() {
  // Convert Maps to arrays for serialization
  const topIps = Array.from(metrics.hitsByIp.entries())
    .map(([ip, data]) => ({ ip, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
  
  const topRoutes = Array.from(metrics.hitsByRoute.entries())
    .map(([route, data]) => ({ route, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
  
  return {
    totalHits: metrics.totalHits,
    totalBlocked: metrics.totalBlocked,
    totalBypassed: metrics.totalBypassed,
    blockRate: metrics.totalHits > 0 
      ? Math.round((metrics.totalBlocked / metrics.totalHits) * 100) 
      : 0,
    bypassRate: metrics.totalHits > 0
      ? Math.round((metrics.totalBypassed / metrics.totalHits) * 100)
      : 0,
    topIps,
    topRoutes,
    recentBlocks: metrics.recentBlocks.slice(0, 20),
    recentBypasses: metrics.recentBypasses.slice(0, 20),
    windowStart: metrics.windowStart,
    windowDuration: METRICS_WINDOW_MS,
  };
}

interface RateLimitConfig {
  rateLimitEnabled: boolean;
  rateLimitPerMinute: number;
  adminRoleMultipliers: Record<string, number>;
  blockRateAlertThreshold: number;  // Alert when block rate exceeds this %
  blockRateAlertEnabled: boolean;
  blockRateAlertCooldown: number;   // Minutes between alerts
}

const DEFAULT_ADMIN_ROLE_MULTIPLIERS: Record<string, number> = {
  'editor': 5,
  'manager': 10,
  'admin': 15,
  'super_admin': 20,
};

let cachedConfig: RateLimitConfig | null = null;
let cachedConfigAt = 0;
const CONFIG_TTL = 30_000;

const DEFAULT_ALERT_CONFIG = {
  blockRateAlertThreshold: 20,  // 20% block rate triggers alert
  blockRateAlertEnabled: true,
  blockRateAlertCooldown: 15,   // 15 minutes between alerts
};

let lastAlertTime = 0;
let alertTriggered = false;

async function getRateLimitConfig(): Promise<RateLimitConfig> {
  if (cachedConfig && Date.now() - cachedConfigAt < CONFIG_TTL) return cachedConfig;
  let config: RateLimitConfig = {
    rateLimitEnabled: true,
    rateLimitPerMinute: MAX_REQUESTS,
    adminRoleMultipliers: DEFAULT_ADMIN_ROLE_MULTIPLIERS,
    ...DEFAULT_ALERT_CONFIG,
  };
  try {
    const { prisma } = await import('../db/prisma');
    const record = await prisma.siteConfig.findUnique({ where: { app: 'api' } });
    const c: any = record?.config || {};
    config = {
      rateLimitEnabled: c.rateLimitEnabled !== undefined ? !!c.rateLimitEnabled : true,
      rateLimitPerMinute: typeof c.rateLimitPerMinute === 'number' && c.rateLimitPerMinute > 0
        ? c.rateLimitPerMinute
        : MAX_REQUESTS,
      adminRoleMultipliers: c.adminRoleMultipliers && typeof c.adminRoleMultipliers === 'object'
        ? { ...DEFAULT_ADMIN_ROLE_MULTIPLIERS, ...c.adminRoleMultipliers }
        : DEFAULT_ADMIN_ROLE_MULTIPLIERS,
      blockRateAlertThreshold: typeof c.blockRateAlertThreshold === 'number'
        ? c.blockRateAlertThreshold
        : DEFAULT_ALERT_CONFIG.blockRateAlertThreshold,
      blockRateAlertEnabled: c.blockRateAlertEnabled !== undefined
        ? !!c.blockRateAlertEnabled
        : DEFAULT_ALERT_CONFIG.blockRateAlertEnabled,
      blockRateAlertCooldown: typeof c.blockRateAlertCooldown === 'number'
        ? c.blockRateAlertCooldown
        : DEFAULT_ALERT_CONFIG.blockRateAlertCooldown,
    };
  } catch {}
  cachedConfig = config;
  cachedConfigAt = Date.now();
  return config;
}

export async function getAdminRoleMultiplier(adminRole: string): Promise<number> {
  const config = await getRateLimitConfig();
  return config.adminRoleMultipliers[adminRole] ?? 10;
}

export async function getRateLimitConfigForExport(): Promise<RateLimitConfig> {
  return getRateLimitConfig();
}

// ─── Block Rate Alert System ───
interface BlockRateAlert {
  timestamp: number;
  blockRate: number;
  threshold: number;
  totalHits: number;
  totalBlocked: number;
  message: string;
}

const g5 = globalThis as any;
if (!g5.__tirbeoRateLimitAlerts) {
  g5.__tirbeoRateLimitAlerts = {
    recentAlerts: [],
    lastAlertTime: 0,
    alertTriggered: false,
  };
}
const alertState = g5.__tirbeoRateLimitAlerts as {
  recentAlerts: BlockRateAlert[];
  lastAlertTime: number;
  alertTriggered: boolean;
};

const MAX_RECENT_ALERTS = 50;

async function checkBlockRateAlert(): Promise<void> {
  const config = await getRateLimitConfig();
  if (!config.blockRateAlertEnabled) return;
  
  const currentBlockRate = metrics.totalHits > 0 
    ? Math.round((metrics.totalBlocked / metrics.totalHits) * 100) 
    : 0;
  
  const now = Date.now();
  const cooldownMs = config.blockRateAlertCooldown * 60 * 1000;
  
  // Check if block rate exceeds threshold
  if (currentBlockRate >= config.blockRateAlertThreshold) {
    // Check cooldown
    if (now - alertState.lastAlertTime >= cooldownMs) {
      // Trigger alert
      const alert: BlockRateAlert = {
        timestamp: now,
        blockRate: currentBlockRate,
        threshold: config.blockRateAlertThreshold,
        totalHits: metrics.totalHits,
        totalBlocked: metrics.totalBlocked,
        message: `Block rate ${currentBlockRate}% exceeds threshold ${config.blockRateAlertThreshold}%`,
      };
      
      alertState.recentAlerts.unshift(alert);
      if (alertState.recentAlerts.length > MAX_RECENT_ALERTS) {
        alertState.recentAlerts.pop();
      }
      alertState.lastAlertTime = now;
      alertState.alertTriggered = true;
      
      // Send notification
      await sendBlockRateAlert(alert);
      
      console.log(`[RATE-LIMIT-ALERT] ${alert.message}`);
    }
  } else {
    // Reset alert triggered flag when rate drops below threshold
    if (alertState.alertTriggered && currentBlockRate < config.blockRateAlertThreshold * 0.8) {
      alertState.alertTriggered = false;
    }
  }
}

async function sendBlockRateAlert(alert: BlockRateAlert): Promise<void> {
  try {
    // Send email notification to admins
    const { sendTemplateEmail } = await import('../email');
    const { prisma } = await import('../db/prisma');
    
    // Get admin emails
    const admins = await prisma.user.findMany({
      where: { adminRole: { not: null } },
      select: { email: true, name: true },
      take: 10,
    });
    
    for (const admin of admins) {
      await sendTemplateEmail(admin.email, 'admin_alert', {
        name: admin.name || 'Admin',
        subject: 'Rate Limit Alert: High Block Rate Detected',
        message: alert.message,
        details: `<div style="padding:16px;border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;">
          <p style="margin:0;font-size:14px;color:#17150f;"><strong>Block Rate:</strong> ${alert.blockRate}%</p>
          <p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong>Threshold:</strong> ${alert.threshold}%</p>
          <p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong>Total Requests:</strong> ${alert.totalHits}</p>
          <p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong>Total Blocked:</strong> ${alert.totalBlocked}</p>
          <p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong>Time:</strong> ${new Date(alert.timestamp).toLocaleString()}</p>
        </div>`,
        dashboardUrl: process.env.NEXT_PUBLIC_ADMIN_URL || 'https://admin.tirbeo.app',
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[RATE-LIMIT-ALERT] Failed to send alert email:', err);
  }
}

export function getBlockRateAlerts() {
  return {
    recentAlerts: alertState.recentAlerts.slice(0, 20),
    lastAlertTime: alertState.lastAlertTime,
    alertTriggered: alertState.alertTriggered,
  };
}

// Start periodic alert checking (every 30 seconds)
let alertCheckInterval: ReturnType<typeof setInterval> | null = null;

function startAlertChecker(): void {
  if (alertCheckInterval) return;
  alertCheckInterval = setInterval(() => {
    checkBlockRateAlert().catch(() => {});
  }, 30000);
}

// Start on module load
startAlertChecker();

const ROUTE_LIMITS: Record<string, number> = {
  'auth/login': 10,
  'auth/signup': 5,
  'auth/email-exists': 20,
  'auth/username-exists': 20,
  'auth/email-otp/request': 5,
  'auth/phone-otp/request': 5,
  'auth/magic-link/request': 5,
  'auth/password-reset/request': 5,
  'auth/signup-otp/request': 5,
  'auth/login-otp/request': 5,
  'auth/login-otp/verify': 10,
  'auth/verify-email': 10,
  'auth/password-reset/verify': 10,
  'auth/password-reset/confirm': 5,
  'auth/magic-link/verify': 10,
  'security/totp/setup': 10,
  'security/totp/verify': 10,
  'security/password': 10,
  'auth/switch-account': 30,
  'auth/accounts/remove': 30,
  'forms/public/[publicId]/submit': 10,
  'feedback': 5,
  'waitlist': 5,
};

import { getCachedRedisClient } from '../db/redis';
import type Redis from 'ioredis';

let redis: Redis | false | null = null;
const REDIS_URL = process.env.REDIS_URL;

async function getRedis(): Promise<Redis | false> {
  if (redis !== null) return redis;
  if (REDIS_URL) {
    try {
      redis = getCachedRedisClient('rate-limit', {
        url: REDIS_URL,
        enableKeepAlive: false, // Rate limiting doesn't need keep-alive
      });
    } catch {
      redis = false;
    }
  } else {
    redis = false;
  }
  return redis;
}

function ipFromKey(key: string): string {
  const slash = key.indexOf('/');
  const head = slash > 0 ? key.slice(0, slash) : key;
  return head.replace(/:$/, '');
}

// Set to false in development to disable all rate limiting
const ENABLE_RATE_LIMITING = process.env.NODE_ENV === 'production';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset: number; // seconds until window resets
}

export async function checkRateLimit(
  key: string,
  isAuth = false,
  routeLimit?: number,
  isAdmin = false,
  userId?: string,
  adminRole?: string
): Promise<boolean> {
  const result = await checkRateLimitWithInfo(key, isAuth, routeLimit, isAdmin, userId, adminRole);
  return result.allowed;
}

export async function checkRateLimitWithInfo(
  key: string,
  isAuth = false,
  routeLimit?: number,
  isAdmin = false,
  userId?: string,
  adminRole?: string
): Promise<RateLimitResult> {
  const resetSeconds = Math.ceil((WINDOW_MS - (Date.now() % WINDOW_MS)) / 1000);
  
  // Always allow in development (no config needed)
  if (!ENABLE_RATE_LIMITING) {
    const devLimit = isAuth ? AUTH_MAX : MAX_REQUESTS;
    return { allowed: true, limit: devLimit, remaining: devLimit, reset: resetSeconds };
  }
  
  const config = await getRateLimitConfig();
  const configuredMax = config.rateLimitPerMinute;
  const defaultMax = isAuth ? AUTH_MAX : MAX_REQUESTS;
  
  // Get role-specific multiplier
  const multiplier = isAdmin && adminRole
    ? (config.adminRoleMultipliers[adminRole] ?? 10)
    : (isAdmin ? 10 : 1);
  
  // Admins get higher limits based on their role
  const baseMax = isAdmin ? defaultMax * multiplier : defaultMax;
  const max = Math.min(routeLimit ?? baseMax, isAdmin ? configuredMax * multiplier : configuredMax);
  
  if (!config.rateLimitEnabled) return { allowed: true, limit: max, remaining: max, reset: resetSeconds };
  
  // Log bypass if admin would have been rate limited with normal limits
  if (isAdmin) {
    const normalMax = Math.min(routeLimit ?? defaultMax, configuredMax);
    const r2 = await getRedis();
    let currentCount = 0;
    
    if (r2) {
      try {
        const window = Math.floor(Date.now() / WINDOW_MS);
        const redisKey = `ratelimit:${key}:${window}`;
        currentCount = await r2.get(redisKey).then(v => parseInt(v || '0', 10));
      } catch {}
    } else {
      const counters = (globalThis as any).__rateLimitCounters ?? new Map();
      const entry = counters.get(key);
      if (entry && Date.now() <= entry.expires) {
        currentCount = entry.count;
      }
    }
    
    // If normal user would have been blocked, log the bypass
    if (currentCount > normalMax && currentCount <= max) {
      recordBypass(ipFromKey(key), key, userId || 'unknown');
    }
  }
  const r = await getRedis();

  if (r) {
    try {
      const window = Math.floor(Date.now() / WINDOW_MS);
      const redisKey = `ratelimit:${key}:${window}`;
      const count = await r.incr(redisKey);
      if (count === 1) await r.pexpire(redisKey, WINDOW_MS);
      if (count > max) {
        recordRateLimitHit(ipFromKey(key));
        recordMetrics(ipFromKey(key), key, true);
        return { allowed: false, limit: max, remaining: 0, reset: resetSeconds };
      }
      // Record successful hit
      recordMetrics(ipFromKey(key), key, false);
      return { allowed: true, limit: max, remaining: Math.max(0, max - count), reset: resetSeconds };
    } catch {
      // fall through to in-memory
    }
  }

  const counters = (globalThis as any).__rateLimitCounters ?? new Map<string, { count: number; expires: number }>();
  (globalThis as any).__rateLimitCounters = counters;
  const now = Date.now();
  if (counters.size > 5000) {
    for (const [k, v] of counters) {
      if (now > v.expires) counters.delete(k);
    }
  }
  const entry = counters.get(key) ?? { count: 0, expires: now + WINDOW_MS };
  if (now > entry.expires) {
    entry.count = 0;
    entry.expires = now + WINDOW_MS;
  }
  entry.count++;
  counters.set(key, entry);
  if (entry.count > max) {
    recordRateLimitHit(ipFromKey(key));
    recordMetrics(ipFromKey(key), key, true);
    return { allowed: false, limit: max, remaining: 0, reset: resetSeconds };
  }
  
  // Record successful hit
  recordMetrics(ipFromKey(key), key, false);
  return { allowed: true, limit: max, remaining: Math.max(0, max - entry.count), reset: resetSeconds };
}

export { ROUTE_LIMITS };

