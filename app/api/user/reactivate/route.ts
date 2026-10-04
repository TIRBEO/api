import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/features/auth/http-guards';
import {
  reactivateAccount, requestReactivationByEmail, reactivateByEmailCode,
} from '@/features/status/accountLifecycle';

export const runtime = 'nodejs';

/**
 * POST /api/user/reactivate — bring a deactivated account back.
 *
 * Two paths, because deactivation keeps the pausing session alive but refuses
 * NEW sign-ins:
 *   • With a live session (the person is still on the deactivated screen) it
 *     reactivates directly.
 *   • Without one, they prove ownership of the sign-in email with a code —
 *     { step:'request', email } sends it, { step:'verify', email, code } spends
 *     it and restores the account.
 *
 * The proxy status gate lets writes whose path contains "reactivate" through
 * even while the account is deactivated, so this is reachable either way.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    const body = await request.json().catch(() => ({}));
    const { step, code, email } = body as { step?: string; code?: string; email?: string };

    // Signed-in undo — the common path right after deactivating.
    if (session) {
      const result = await reactivateAccount(session.userId);
      const { bustProfileCache } = await import('@/features/auth/authHandlers');
      bustProfileCache(session.userId);
      return NextResponse.json({ ok: true, status: result.status, message: 'Account reactivated' });
    }

    // Signed-out: email-code reactivation.
    if (!email) return NextResponse.json({ error: 'Email is required' }, { status: 400 });

    if (step === 'request') {
      const issued = await requestReactivationByEmail(email);
      if (!issued.ok) {
        if (issued.reason === 'cooldown') return NextResponse.json({ error: 'Please wait before requesting another code.' }, { status: 429 });
        if (issued.reason === 'not_deactivated') return NextResponse.json({ error: 'This account is not deactivated.' }, { status: 400 });
        return NextResponse.json({ error: 'No account found for that email.' }, { status: 404 });
      }
      const { sendTemplateEmail } = await import('@/features/email/email');
      await sendTemplateEmail(email, 'verify_email', { otp: issued.code! }).catch((e) => console.error('[REACTIVATE OTP]', e?.message));
      return NextResponse.json({ ok: true, step: 'request', message: `Reactivation code sent to ${email}` });
    }

    if (step === 'verify') {
      if (!code) return NextResponse.json({ error: 'Verification code is required' }, { status: 400 });
      const done = await reactivateByEmailCode(email, String(code));
      if (!done.ok) {
        if (done.reason === 'no_account') return NextResponse.json({ error: 'No account found for that email.' }, { status: 404 });
        return NextResponse.json({ error: 'Invalid or expired code' }, { status: 400 });
      }
      return NextResponse.json({ ok: true, step: 'verify', message: 'Account reactivated. You can sign in again.' });
    }

    return NextResponse.json({ error: 'Invalid step. Use "request" or "verify".' }, { status: 400 });
  } catch (err: any) {
    console.error('[REACTIVATE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to reactivate account' }, { status: 500 });
  }
}
