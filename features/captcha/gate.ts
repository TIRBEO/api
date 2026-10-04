import { prisma } from '@/infrastructure/db/prisma';
import { verifyTurnstile } from '@/features/auth/turnstile';

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
 * Turnstile-only CAPTCHA gate — replaces the removed custom challenge
 * engine (features/captcha/service.ts). Verifies one Cloudflare Turnstile
 * token; fails closed when the token is missing or invalid.
 */
export async function requireCaptchaGate(opts: { token?: string | null; ipAddress?: string }): Promise<{ ok: boolean; error?: string }> {
  const token = opts.token?.trim();
  if (!token) {
    return { ok: false, error: 'CAPTCHA verification required. Please complete the challenge.' };
  }
  const ok = await verifyTurnstile(token, opts.ipAddress);
  if (!ok) {
    return { ok: false, error: 'CAPTCHA verification failed. Please try again.' };
  }
  return { ok: true };
}