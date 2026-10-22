import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/features/auth/http-guards';
import { jsonUnauthorized } from '@/shared/response';
import { deactivateAccount } from '@/features/status/accountLifecycle';
import { sendTemplateEmailAfter } from '@/features/email/email';
import { primaryEmailForUser } from '@/features/notifications/notifications';
import { getAccountsBaseUrl } from '@/config/app-urls';

export const runtime = 'nodejs';

/**
 * POST /api/user/deactivate — pause the account (soft door).
 *
 * The account enters a distinct `deactivated` state. The current session is
 * kept alive so the person reaches the "deactivated" screen and can undo it in
 * place; every other device is signed out. New sign-ins are refused separately
 * (loginHandler + the proxy status gate). Requires a live session — the browser
 * sends the CSRF token on this write, so the edge rejects a forged one.
 *
 * The pause is confirmed by mail to the sign-in address: revoking every other
 * device is the part a person should not have to notice by itself.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body = await request.json().catch(() => ({}));
    const reason = (body as any)?.reason ?? null;

    const result = await deactivateAccount(session.userId, {
      keepSessionId: session.sessionId ?? null,
      reason,
    });
    const { bustProfileCache } = await import('@/features/auth/authHandlers');
    bustProfileCache(session.userId);

    const email = await primaryEmailForUser(session.userId).catch(() => null);
    if (email) {
      sendTemplateEmailAfter(email, 'account_deactivated', {
        primaryEmail: email,
        dateLabel: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
        reason: typeof reason === 'string' && reason.trim() ? reason.trim() : 'Not given',
        accountsUrl: getAccountsBaseUrl(),
      });
    }

    return NextResponse.json({ ok: true, status: result.status, message: 'Account deactivated' });
  } catch (err: any) {
    console.error('[DEACTIVATE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to deactivate account' }, { status: 500 });
  }
}
