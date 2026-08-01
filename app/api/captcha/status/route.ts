import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { isBlocked, getRequiredDifficulty, getCaptchaSettings } from '@/lib/captcha/service';
import { computeRiskScore } from '@/lib/captcha/risk';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    const captchaSessionId = request.cookies.get('__captcha_session')?.value;
    const sessionId = session?.sessionId || captchaSessionId || 'anonymous';
    const ipAddress = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || '';
    const fingerprint = request.cookies.get('__dfp')?.value || request.headers.get('x-device-fingerprint') || '';

    const userId = session?.userId;
    const settings = await getCaptchaSettings();

    const blockStatus = await isBlocked(userId, sessionId, ipAddress);

    let risk = null;
    if (settings.riskEnabled) {
      risk = await computeRiskScore({ ip: ipAddress, ua: userAgent, userId, sessionId, fingerprint, authPath: true });
    }
    const difficulty = await getRequiredDifficulty(userId, sessionId, ipAddress, risk);

    return NextResponse.json({
      blocked: blockStatus.blocked,
      rayId: blockStatus.rayId,
      reason: blockStatus.reason,
      expiresAt: blockStatus.expiresAt,
      requiredDifficulty: difficulty,
      level: risk?.level || null,
      score: risk?.score ?? null,
      requireCaptcha: settings.enabled && (risk?.requireCaptcha || difficulty !== 'easy'),
      captchaEnabled: settings.enabled,
    });
  } catch (err: any) {
    console.error('[CAPTCHA] Status error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to check status' }, { status: 500 });
  }
}
