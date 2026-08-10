import { createHash } from 'crypto';
import { prisma } from '../db/prisma';
import { isIpBlocked } from '../security';
import { isSuspicious } from '../auth/suspicious-activity';

export type RiskLevel = 'none' | 'invisible' | 'standard' | 'strong';

export interface RiskResult {
  score: number;
  level: RiskLevel;
  reasons: string[];
  requireCaptcha: boolean;
}

export interface BehaviorData {
  startedAt?: number;
  submittedAt?: number;
  samples?: { t: number; x: number; y: number }[];
  keys?: { t: number; hold: number; gap: number }[];
  scrollCount?: number;
  focusBlurs?: number;
  clicks?: number;
  screen?: string;
  dpr?: number;
  jsEnabled?: boolean;
  reducedMotion?: boolean;
  touch?: boolean;
}

export interface RiskInput {
  ip?: string;
  ua?: string;
  userId?: string;
  sessionId?: string;
  fingerprint?: string;
  behavior?: BehaviorData;
  authPath?: boolean;
}

export function hashString(value: string): string {
  return createHash('sha256').update(value || '').digest('hex');
}

export function computeDeviceFingerprint(input: {
  ua: string;
  lang?: string;
  platform?: string;
  screen?: string;
  timezone?: string;
  dpr?: number;
  touch?: boolean;
}): string {
  return hashString(
    [input.ua, input.lang, input.platform, input.screen, input.timezone, input.dpr, input.touch].join('|')
  );
}

const AUTOMATION_PATTERNS: RegExp[] = [
  /\bheadless/i,
  /\bphantomjs\b/i,
  /\bpuppeteer/i,
  /\bplaywright/i,
  /\bselenium\b/i,
  /webdriver/i,
  /chromedriver/i,
  /geckodriver/i,
  /\bcurl\//i,
  /\bwget\//i,
  /python-requests/i,
  /node-fetch/i,
  /postmanruntime/i,
  /okhttp/i,
];

export function detectAutomation(ua: string): number {
  if (!ua || !ua.trim()) return 30;
  let score = 0;
  for (const p of AUTOMATION_PATTERNS) {
    if (p.test(ua)) score += 10;
  }
  return Math.min(30, score);
}

export function analyzeBehavior(behavior: BehaviorData | undefined): { score: number; reasons: string[] } {
  if (!behavior) return { score: 0, reasons: ['no behavior signal'] };

  const reasons: string[] = [];
  let score = 0;

  const start = behavior.startedAt || 0;
  const submit = behavior.submittedAt || 0;
  const elapsed = submit > start ? (submit - start) / 1000 : 0;

  if (elapsed === 0) {
    score += 30;
    reasons.push('no interaction time');
  } else if (elapsed < 1.2) {
    score += 25;
    reasons.push('solved unusually fast');
  }

  const samples = behavior.samples || [];
  if (samples.length < 4) {
    score += 15;
    reasons.push('insufficient pointer activity');
  }

  if (samples.length >= 5) {
    let dist = 0;
    let speedVariance = 0;
    const steps: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      const dx = samples[i].x - samples[i - 1].x;
      const dy = samples[i].y - samples[i - 1].y;
      const step = Math.sqrt(dx * dx + dy * dy);
      steps.push(step);
      dist += step;
    }
    const avg = dist / steps.length;
    for (const s of steps) speedVariance += Math.abs(s - avg);
    const jitter = speedVariance / steps.length;

    if (dist < 30 && samples.length > 4) {
      score += 10;
      reasons.push('suspiciously still pointer');
    }
    if (jitter < 0.5) {
      score += 15;
      reasons.push('unnatural constant speed');
    }
  }

  const scrolls = behavior.scrollCount || 0;
  if (scrolls > 40) {
    score += 10;
    reasons.push('excessive scrolling');
  }

  if ((behavior.focusBlurs || 0) >= 4) {
    score += 8;
    reasons.push('repeated tab switches');
  }

  return { score: Math.min(100, score), reasons };
}

// ─── Sliding-window rate limiter (in-memory, edge-safe) ───
const windows = new Map<string, { count: number; reset: number }>();

/** Clear all rate limit windows (for development/testing) */
export function clearRateLimits(): void {
  windows.clear();
}

/** Clear rate limits matching a pattern */
export function clearRateLimitsByPattern(pattern: string): void {
  for (const key of windows.keys()) {
    if (key.includes(pattern)) {
      windows.delete(key);
    }
  }
}

/**
 * Check if a request is within rate limits.
 * DISABLED for development - always allows.
 * Re-enable by setting ENABLE_RATE_LIMITING = true
 */
const ENABLE_RATE_LIMITING = false; // Set to true in production

export function checkWindowLimit(key: string, max: number, windowMs: number): boolean {
  if (!ENABLE_RATE_LIMITING) {
    return true; // Always allow in development
  }
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now > w.reset) {
    w = { count: 0, reset: now + windowMs };
    windows.set(key, w);
  }
  w.count++;
  if (windows.size > 2000) {
    for (const [k, v] of windows) {
      if (now > v.reset) windows.delete(k);
    }
  }
  return w.count <= max;
}

// ─── Same-device multi-account detection ───
const deviceCache = new Map<string, { data: { users: number; sessions: number }; ts: number }>();
const DEVICE_CACHE_TTL = 60_000; // 60s cache per device fingerprint

export async function countAccountsForDevice(fingerprint: string, sinceHours = 24): Promise<{ users: number; sessions: number }> {
  if (!fingerprint || fingerprint.length < 16) return { users: 0, sessions: 0 };
  // Use first 32 chars as cache key to keep map size small
  const cacheKey = fingerprint.slice(0, 32);
  const cached = deviceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DEVICE_CACHE_TTL) return cached.data;
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  try {
    const [seen, count] = await Promise.all([
      prisma.securityEvent.findMany({
        where: {
          eventType: 'device.seen',
          createdAt: { gte: since },
          metadata: { path: ['deviceFp'], equals: fingerprint },
        },
        select: { userId: true },
        distinct: ['userId'],
      }),
      prisma.securityEvent.count({
        where: {
          eventType: 'device.seen',
          createdAt: { gte: since },
          metadata: { path: ['deviceFp'], equals: fingerprint },
        },
      }),
    ]);
    const users = new Set(seen.map(s => s.userId).filter(Boolean));
    const result = { users: users.size, sessions: count };
    deviceCache.set(cacheKey, { data: result, ts: Date.now() });
    if (deviceCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of deviceCache) {
        if (now - v.ts > DEVICE_CACHE_TTL) deviceCache.delete(k);
      }
    }
    return result;
  } catch {
    return { users: 0, sessions: 0 };
  }
}

export async function recordDeviceSeen(opts: {
  fingerprint?: string;
  userId?: string;
  ip?: string;
  ua?: string;
  sessionId?: string;
}): Promise<void> {
  if (!opts.fingerprint || opts.fingerprint.length < 16) return;
  try {
    await prisma.securityEvent.create({
      data: {
        userId: opts.userId || null,
        eventType: 'device.seen',
        severity: 'info',
        ipAddress: opts.ip,
        userAgent: opts.ua,
        metadata: { deviceFp: opts.fingerprint, sessionId: opts.sessionId || null } as never,
      },
    });
  } catch {
    // Best effort — device telemetry must never block auth
  }
}

// A recent successful login from this IP means the risk was already cleared —
// let the score decay back to normal instead of staying elevated (PRD: CAPTCHA
// resets when traffic normalizes).
const LOGIN_SUCCESS_EVENTS = ['auth.login_success', 'auth.admin_login_success', 'auth.login_2fa_success', 'auth.login_otp_success'];
const LOGIN_SUCCESS_FORGIVENESS_MS = 30 * 60 * 1000;

// Cache recent login success check per IP (30s TTL)
const loginSuccessCache = new Map<string, { result: boolean; ts: number }>();
const LOGIN_SUCCESS_CACHE_TTL = 30_000;

export async function hasRecentLoginSuccess(ip?: string, sinceMs = LOGIN_SUCCESS_FORGIVENESS_MS): Promise<boolean> {
  if (!ip || ip === 'unknown') return false;
  const cached = loginSuccessCache.get(ip);
  if (cached && Date.now() - cached.ts < LOGIN_SUCCESS_CACHE_TTL) return cached.result;
  try {
    const since = new Date(Date.now() - sinceMs);
    const count = await prisma.securityEvent.count({
      where: {
        eventType: { in: LOGIN_SUCCESS_EVENTS },
        ipAddress: ip,
        createdAt: { gte: since },
      },
    });
    const result = count > 0;
    loginSuccessCache.set(ip, { result, ts: Date.now() });
    if (loginSuccessCache.size > 5000) {
      const now = Date.now();
      for (const [k, v] of loginSuccessCache) {
        if (now - v.ts > LOGIN_SUCCESS_CACHE_TTL) loginSuccessCache.delete(k);
      }
    }
    return result;
  } catch {
    return false;
  }
}

export function riskLevelFromScore(score: number): RiskLevel {
  if (score <= 20) return 'none';
  if (score <= 50) return 'invisible';
  if (score <= 80) return 'standard';
  return 'strong';
}

export async function computeRiskScore(input: RiskInput): Promise<RiskResult> {
  const reasons: string[] = [];
  let score = 0;

  score += detectAutomation(input.ua || '');

  if (!input.fingerprint || input.fingerprint.length < 16) {
    score += 10;
    reasons.push('missing device fingerprint');
  }

  const checks: Promise<void>[] = [];

  if (input.ip) {
    const recentSuccess = hasRecentLoginSuccess(input.ip);
    checks.push(
      (async () => {
        const ok = await recentSuccess;
        if (ok) return; // user already proved who they are — clear suspicion
        const blocked = await isIpBlocked(input.ip || '');
        if (blocked) {
          score += 40;
          reasons.push('IP is blocked');
        }
      })()
    );
    checks.push(
      (async () => {
        const ok = await recentSuccess;
        if (ok) return; // clear rate-limit suspicion after a successful login
        if (isSuspicious(input.ip || '')) {
          score += 15;
          reasons.push('recent rate-limit hits');
        }
      })()
    );
    checks.push(
      (async () => {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        try {
          const ok = await recentSuccess;
          const [loginFails, captchaFails] = await Promise.all([
            prisma.securityEvent.count({
              where: {
                eventType: { in: ['auth.login_failed', 'auth.signup_failed', 'auth.2fa_failed'] },
                ipAddress: input.ip,
                createdAt: { gte: since },
              },
            }),
            prisma.captchaLog.count({
              where: { eventType: 'attempt_failed', ipAddress: input.ip, createdAt: { gte: since } },
            }),
          ]);
          if (ok) {
            // Logins are working again — failures happened before the user
            // proved identity, so don't keep compounding the score.
            if (loginFails >= 10) {
              score += 8;
              reasons.push('repeated past failed sign-ins');
            }
            if (captchaFails >= 10) {
              score += 5;
              reasons.push('repeated past captcha failures');
            }
          } else {
            if (loginFails >= 5) {
              score += 20;
              reasons.push('repeated failed sign-ins');
            } else if (loginFails >= 2) {
              score += 8;
            }
            if (captchaFails >= 5) {
              score += 15;
              reasons.push('repeated captcha failures');
            } else if (captchaFails >= 2) {
              score += 5;
            }
          }
        } catch {
          // best effort
        }
      })()
    );
    checks.push(
      (async () => {
        if (!checkWindowLimit(`burst:${input.ip}`, 90, 60 * 1000)) {
          score += 20;
          reasons.push('high request frequency');
        }
      })()
    );
  }

  if (input.fingerprint) {
    checks.push(
      (async () => {
        const multi = await countAccountsForDevice(input.fingerprint || '');
        if (multi.users >= 5) {
          score += 35;
          reasons.push('many accounts on this device');
        } else if (multi.users >= 3) {
          score += 22;
          reasons.push('multiple accounts on this device');
        } else if (multi.users >= 2) {
          score += 10;
          reasons.push('prior account on this device');
        }
      })()
    );
  }

  await Promise.all(checks);

  if (input.authPath && !input.sessionId) {
    score += 5;
  }

  const behavior = analyzeBehavior(input.behavior);
  score += behavior.score;
  reasons.push(...behavior.reasons);

  score = Math.min(100, Math.round(score));
  const level = riskLevelFromScore(score);

  return {
    score,
    level,
    reasons: Array.from(new Set(reasons)).slice(0, 8),
    requireCaptcha: score >= 51,
  };
}
