import { prisma } from '@/infrastructure/db/prisma';
import { verifyTurnstile, isTurnstileConfigured } from '@/features/auth/turnstile';
import { checkWindowLimitDB } from '@/features/captcha/risk';
import { isSuspiciousAsync } from '@/features/auth/suspicious-activity';

const WARNING_CACHE_TTL = 5 * 60 * 1000;
const warningCountCache = new Map<string, { count: number; recentBlocks: number; at: number }>();

// ── Graceful captcha fallback ──────────────────────────────────────────────
// A hard 403 on a missing Turnstile token is a dead end whenever the widget
// itself cannot load: challenges.cloudflare.com unreachable (corporate/VPN
// networks, outages), aggressive ad-blockers, or a half-deployed site key.
// Real users were permanently locked out of password resets, login OTPs and
// magic links — no client-side retry can ever succeed.
//
// So a request without a *valid* token is not rejected outright. It is
// suspicion-aware: only an IP that already looks abusive rides the tightened
// secondary budget; a normal / anonymous tokenless request is NOT metered here
// at all and simply proceeds under the standard per-endpoint per-IP limits the
// caller already enforces (those endpoint windows are the real control, and a
// human doing a couple of legit sends never comes close to them). An IP is
// treated as suspicious when it carries a recent `captcha.blocked` /
// `captcha.attempt_failed` audit trail OR the shared suspicious-IP tracker
// (`isSuspiciousAsync`) has it flagged — both signals already exist in the
// repo, nothing new is invented.
//
// When an IP *is* suspicious, the tightened budget is 30 attempts per hour per
// IP — high enough that no real user can trip it by accident (the whole point:
// only scripters should ever see a wall), low enough to bound abuse, and every
// bypass is audited as `captcha.fallback_bypassed`. The durable-window
// machinery and blocklist/abuse handling in `checkWindowLimitDB` are unchanged.
// When Turnstile is not fully configured the whole gate remains a no-op (env
// kill-switch, unchanged).
const FALLBACK_MAX = 30;
const FALLBACK_WINDOW_MS = 60 * 60 * 1000;

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
 * Audit the fallback bypass. Unlike `recordGateFailure` this must also land
 * for anonymous requests (user_id is nullable since the anonymous-events
 * change), because the pre-login flows that ride the fallback — password
 * reset, login OTP, magic link — have no user row to point at.
 */
function recordFallbackBypass(userId: string | undefined, ipAddress: string | undefined, hadToken: boolean): void {
  void prisma.activityEvent
    .create({
      data: {
        userId: userId || null,
        kind: 'captcha.fallback_bypassed',
        title: 'CAPTCHA fallback used',
        detail: hadToken
          ? 'Request allowed without a passed captcha (invalid token) under the tightened per-IP budget'
          : 'Request allowed without a captcha token under the tightened per-IP budget',
        severity: 'warning',
        ipAddress: ipAddress || null,
        metadata: { source: 'turnstile', fallback: true, budgetMax: FALLBACK_MAX, budgetWindowMs: FALLBACK_WINDOW_MS, hadToken },
      },
    })
    .catch(() => {});
}

/**
 * The stricter secondary gate for requests that arrive without a valid
 * Turnstile token. Returns true when the IP still has fallback budget left
 * (the request proceeds, captcha-less), false when the budget is spent.
 */
async function captchaFallbackAllowed(ipAddress: string | undefined): Promise<boolean> {
  const ip = ipAddress || 'unknown';
  return checkWindowLimitDB(`captcha-fallback:ip:${ip}`, FALLBACK_MAX, FALLBACK_WINDOW_MS, ip);
}

/**
 * Recent `captcha.blocked` / `captcha.attempt_failed` audit trail for an IP.
 * Reuses the very events `getUserWarningCount` and `computeRiskScore` already
 * read as their escalation signal — an IP whose last day shows failed captcha
 * challenges is a candidate for the tightened fallback budget; a fresh, normal
 * IP is not. Best-effort: any DB error means "not suspicious" so a benign
 * request is never metered by accident.
 */
async function hasRecentCaptchaFailureTrail(ip: string): Promise<boolean> {
  if (!ip || ip === 'unknown') return false;
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await prisma.activityEvent.count({
      where: {
        ipAddress: ip,
        kind: { in: ['captcha.blocked', 'captcha.attempt_failed'] },
        createdAt: { gte: dayAgo },
      },
    });
    return count > 0;
  } catch {
    return false;
  }
}

/**
 * Should this IP be metered by the tightened tokenless fallback budget at all?
 * Only a genuinely suspicious IP is: one flagged by the shared suspicious-IP
 * tracker (`isSuspiciousAsync` — recent rate-limit hits) or carrying a recent
 * captcha-failure trail. A normal / anonymous tokenless request returns false
 * so the caller lets it through under the endpoint's own standard per-IP
 * limits — the real, human-safe control. This keeps the fallback from ever
 * trapping a legitimate user whose widget simply could not load.
 */
async function shouldMeterTokenlessFallback(ipAddress: string | undefined): Promise<boolean> {
  const ip = ipAddress || 'unknown';
  if (await hasRecentCaptchaFailureTrail(ip)) return true;
  try {
    return await isSuspiciousAsync(ip);
  } catch {
    return false;
  }
}

/**
 * Turnstile-only CAPTCHA gate — replaces the removed custom challenge
 * engine (features/captcha/service.ts). Verifies one Cloudflare Turnstile
 * token. A valid token passes with the standard limits untouched; a missing
 * or invalid token does NOT hard-fail. It is suspicion-aware: a normal /
 * anonymous tokenless request proceeds under the endpoint's own standard
 * per-IP limits, while only an already-suspicious IP is metered by the
 * tightened per-IP fallback budget documented above (and only errors once
 * that budget is spent).
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
  const verified = token ? await verifyTurnstile(token, opts.ipAddress) : false;
  if (verified) return { ok: true };

  // Decide metering BEFORE recording this request's failure, so a single
  // benign tokenless hit never manufactures its own "suspicious" trail.
  const suspicious = await shouldMeterTokenlessFallback(opts.ipAddress);

  // Record the miss so a genuine repeat offender accumulates the trail that
  // eventually trips the tightened budget. Anonymous hits (no userId) can't
  // write the user-keyed event, so they never self-escalate — exactly the
  // pre-login flows (magic link / login OTP / password reset) we must keep
  // reachable.
  recordGateFailure(opts.userId || '', opts.ipAddress, !token);

  // Normal / anonymous tokenless request: not this IP's business to be
  // tightened. Proceed; the endpoint's standard per-IP limits govern volume.
  if (!suspicious) return { ok: true };

  if (await captchaFallbackAllowed(opts.ipAddress)) {
    recordFallbackBypass(opts.userId, opts.ipAddress, Boolean(token));
    return { ok: true };
  }
  return { ok: false, error: 'Too many attempts without a passed security check. Please try again in about an hour.' };
}