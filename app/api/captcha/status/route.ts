import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import {
  isBlocked,
  getRequiredDifficulty,
  getCaptchaSettings,
  getUserWarningCount,
  getSessionWarningCount,
} from '@/lib/captcha/service';
import { computeRiskScore } from '@/lib/captcha/risk';
import { createTtlCache } from '@/lib/cache';

export const runtime = 'nodejs';

// The status endpoint fans out into several DB reads per request. Cache the
// whole result briefly keyed by session+IP — CAPTCHA gating tolerates a few
// seconds of staleness and the client polls repeatedly.
const statusCache = createTtlCache<Record<string, unknown>>(10_000, 5000);

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    const captchaSessionId = request.cookies.get('__captcha_session')?.value;
    const sessionId = session?.sessionId || captchaSessionId || 'anonymous';
    const ipAddress = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || '';
    const fingerprint = request.cookies.get('__dfp')?.value || request.headers.get('x-device-fingerprint') || '';

    const cacheKey = `${session?.userId || ''}|${sessionId}|${ipAddress}`;
    const cached = statusCache.get(cacheKey);
    if (cached) return NextResponse.json(cached);

    const userId = session?.userId;
    const settings = await getCaptchaSettings();

    const blockStatus = await isBlocked(userId, sessionId, ipAddress);

    let risk = null;
    if (settings.riskEnabled) {
      risk = await computeRiskScore({ ip: ipAddress, ua: userAgent, userId, sessionId, fingerprint, authPath: true });
    }
    const difficulty = await getRequiredDifficulty(userId, sessionId, ipAddress, risk);

    // Mirror the login handler's progressive-friction gate exactly, so the
    // client shows a CAPTCHA precisely when the server would demand one.
    const userWarnings = userId ? await getUserWarningCount(userId, ipAddress) : { count: 0, recentBlocks: 0 };
    const sessionWarnings = sessionId ? await getSessionWarningCount(sessionId) : { count: 0, recentBlocks: 0 };
    const warningCount = Math.max(userWarnings.count, sessionWarnings.count);
    const recentBlocks = userWarnings.recentBlocks + sessionWarnings.recentBlocks;
    const forceCaptcha = recentBlocks > 0 || warningCount >= 2;

    const riskCaptcha = !!risk?.requireCaptcha;
    const difficultyCaptcha = difficulty !== 'easy';
    const requireCaptcha = settings.enabled && (forceCaptcha || riskCaptcha || difficultyCaptcha);

    const body = {
      blocked: blockStatus.blocked,
      rayId: blockStatus.rayId,
      reason: blockStatus.reason,
      expiresAt: blockStatus.expiresAt,
      requiredDifficulty: difficulty,
      level: risk?.level || null,
      score: risk?.score ?? null,
      requireCaptcha,
      captchaEnabled: settings.enabled,
      forceCaptcha,
      warningCount,
      recentBlocks,
    };

    statusCache.set(cacheKey, body as Record<string, unknown>);
    return NextResponse.json(body);
  } catch (err: any) {
    console.error('[CAPTCHA] Status error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to check status' }, { status: 500 });
  }
}
