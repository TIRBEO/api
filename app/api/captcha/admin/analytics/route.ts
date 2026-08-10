import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/session';
import { getCaptchaAnalytics, getBlockedUsers, getCaptchaSettings, updateCaptchaSettings } from '@/lib/captcha/service';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  try {
    const rangeParam = request.nextUrl.searchParams.get('range') || '24h';
    const range = rangeParam === '7d' || rangeParam === '30d' ? rangeParam : '24h';

    const [analytics, blocked, settings] = await Promise.all([
      getCaptchaAnalytics(range),
      getBlockedUsers(1, 20),
      getCaptchaSettings(),
    ]);

    return NextResponse.json({ ...analytics, blockedUsers: blocked.blocks, settings });
  } catch (err: any) {
    console.error('[CAPTCHA ADMIN] Analytics error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to load captcha analytics' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  try {
    const body: any = await request.json();
    const allowed: Record<string, unknown> = {};
    if (typeof body.enabled === 'boolean') allowed.enabled = body.enabled;
    if (typeof body.riskEnabled === 'boolean') allowed.riskEnabled = body.riskEnabled;
    if (typeof body.maxAttemptsPerChallenge === 'number') allowed.maxAttemptsPerChallenge = Math.max(1, Math.min(10, body.maxAttemptsPerChallenge));
    if (typeof body.challengeExpiry === 'number') allowed.challengeExpiry = Math.max(1, Math.min(30, body.challengeExpiry));
    if (typeof body.sessionDuration === 'number') allowed.sessionDuration = Math.max(5, Math.min(1440, body.sessionDuration));

    const updated = Object.keys(allowed).length ? await updateCaptchaSettings(allowed) : await getCaptchaSettings();
    return NextResponse.json({ settings: updated });
  } catch (err: any) {
    console.error('[CAPTCHA ADMIN] Update settings error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to update captcha settings' }, { status: 500 });
  }
}
