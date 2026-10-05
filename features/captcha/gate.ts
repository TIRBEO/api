import { prisma } from '@/infrastructure/db/prisma';
import { verifyTurnstile, isTurnstileConfigured } from '@/features/auth/turnstile';

const WARNING_CACHE_TTL = 5 * 60 * 1000;
const warningCountCache = new Map<string, { count: number; recentBlocks: number; at: number }>();

/**
 * Prior failed-attempt / block history for a user — used to decide when
 * progressive friction (a Turnstile challenge) should be required before a
 * login reveals password validity.
 */
export async function getUserWarningCount(userId: string, ipAddress?: string): Promise<{ count: number; recentBlocks: number }> {
  const cacheKey = `${userId}:${ipAddress || ''}`;
  const cached = warningCountCache.get(cacheKey);
  if (cached && Date.now() - cached.at < WARNING_CACHE_TTL) {
    return { count: cached.count, recentBlocks: cached.recentBlocks };
  }
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [warningCount, recentBlocks] = await Promise.all([
      prisma.activityEvent.count({
        where: { userId, kind: { in: ['captcha.attempt_failed', 'captcha.blocked'] }, createdAt: { gte: dayAgo } },
      }),
      Promise.resolve(0),
    ]);
    warningCountCache.set(cacheKey, { count: warningCount, recentBlocks, at: Date.now() });
    if (warningCountCache.size > 5000) {
      const cutoff = Date.now() - WARNING_CACHE_TTL;
      for (const [k, v] of warningCountCache) {
        if (v.at < cutoff) warningCountCache.delete(k);
      }
    }
    return { count: warningCount, recentBlocks };
  } catch {
    return { count: 0, recentBlocks: 0 };
  }
}

/**
 * Record a gate rejection so the *next* attempt can escalate.
 *
 * `getUserWarningCount` (above) and `computeRiskScore` in risk.ts both count
 * `captcha.attempt_failed` / `captcha.blocked` activity events to decide when
 * to add friction — but nothing ever wrote those kinds, so the counters stayed
 * at zero and the progressive-challenge path was dead code. Writing them here
 * closes the loop.
 *
 * Fire-and-forget: a failed audit write must never fail the request.
 */
function recordGateFailure(userId: string, ipAddress: string | undefined, blocked: boolean): void {
  if (!userId) return;
  void prisma.activityEvent
    .create({
      data: {
        userId,
        kind: blocked ? 'captcha.blocked' : 'captcha.attempt_failed',
        title: blocked ? 'CAPTCHA challenge blocked' : 'CAPTCHA attempt failed',
        detail: blocked ? 'Request rejected: captcha challenge required' : 'Request rejected: invalid or missing captcha token',
        severity: blocked ? 'warning' : 'info',
        ipAddress: ipAddress || null,
        metadata: { source: 'turnstile', blocked },
      },
    })
    .catch(() => {});
}

/**
 * Turnstile-only CAPTCHA gate — replaces the removed custom challenge
 * engine (features/captcha/service.ts). Verifies one Cloudflare Turnstile
 * token; fails closed when the token is missing or invalid.
 *
 * A no-op when Turnstile isn't fully configured, so the gate can never reject
 * a request no client could satisfy.
 */
export async function requireCaptchaGate(opts: {
  token?: string | null;
  ipAddress?: string;
  userId?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!isTurnstileConfigured()) return { ok: true };

  const token = opts.token?.trim();
  if (!token) {
    recordGateFailure(opts.userId || '', opts.ipAddress, true);
    return { ok: false, error: 'CAPTCHA verification required. Please complete the challenge.' };
  }
  const ok = await verifyTurnstile(token, opts.ipAddress);
  if (!ok) {
    recordGateFailure(opts.userId || '', opts.ipAddress, false);
    return { ok: false, error: 'CAPTCHA verification failed. Please try again.' };
  }
  return { ok: true };
}