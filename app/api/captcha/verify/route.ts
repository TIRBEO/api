import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { verifyChallenge, getCaptchaSettings } from '@/lib/captcha/service';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body: any = await request.json();
    const { challengeId, answer, token, behavior, fingerprint } = body;

    if (!challengeId || !answer || !token) {
      return NextResponse.json({ error: 'Challenge ID, answer and token required' }, { status: 400 });
    }

    const session = await getSession(request);
    const sessionId = session?.sessionId || request.cookies.get('__captcha_session')?.value || 'anonymous';
    const ipAddress = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || '';
    const cookieFp = request.cookies.get('__dfp')?.value || '';
    const submittedFp = typeof fingerprint === 'string' && fingerprint.length >= 16 ? fingerprint : '';
    const effectiveFp = cookieFp || submittedFp;

    const result = await verifyChallenge({
      challengeId,
      answer: String(answer),
      token: String(token),
      ipAddress,
      userAgent,
      sessionId,
      fingerprint: effectiveFp,
      behavior: behavior && typeof behavior === 'object' ? behavior : undefined,
    });

    if (!result.valid) {
      if (result.blocked) {
        return NextResponse.json({
          valid: false,
          blocked: true,
          rayId: result.rayId,
          reason: result.reason || 'too_many_attempts',
          message: result.reason || 'Too many failed attempts. Access temporarily blocked.',
        }, { status: 403 });
      }
      return NextResponse.json({ valid: false, rayId: result.rayId, reason: result.reason });
    }

    const settings = await getCaptchaSettings();

    return NextResponse.json({
      valid: true,
      rayId: result.rayId,
      nextRequired: result.nextRequired || false,
      requiredLevel: result.risk?.level || null,
      captchaEnabled: settings.enabled,
    });
  } catch (err: any) {
    console.error('[CAPTCHA] Verify error:', err?.message || err);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}
