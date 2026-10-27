import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/features/auth/http-guards';
import { jsonUnauthorized } from '@/shared/response';
import { deactivateAccount } from '@/features/status/accountLifecycle';
import { sendTemplateEmailAfter } from '@/features/email/email';
import { primaryEmailForUser } from '@/features/notifications/notifications';
import { notifyAdmins } from '@/features/security/security';
import { clientIp } from '@/shared/client-ip';
import { resolveLoginPlace } from '@/shared/geo';
import { getAccountsBaseUrl } from '@/config/app-urls';
import { prisma } from '@/infrastructure/db/prisma';

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
 *
 * Staff hear about it too. A pause is reversible and usually harmless, which is
 * exactly why it needs a witness: a support agent reading "the account is
 * missing" has to be able to see that it stepped out, on its own, from an
 * address and a device — and when it did. The alert is the same one every other
 * account-lifecycle change raises, so it lands in the same inbox and the same
 * Activity feed rather than in a screen nobody watches.
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

    await alertStaff(request, session.userId, email, reason);

    return NextResponse.json({ ok: true, status: result.status, message: 'Account deactivated' });
  } catch (err: any) {
    console.error('[DEACTIVATE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to deactivate account' }, { status: 500 });
  }
}

/** The staff copy, after the person's own answer is already on its way. Every
    fact here is one an operator needs and nothing else records: which account,
    who closed it, and from where. */
async function alertStaff(
  request: NextRequest,
  userId: string,
  email: string | null,
  reason: unknown,
): Promise<void> {
  const { deviceDetail } = await import('@/features/notifications/notifications');
  const who = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, name: true },
  }).catch(() => null);
  const ip = clientIp(request.headers) ?? '';
  const device = deviceDetail(request.headers.get('user-agent'));
  const place = resolveLoginPlace(request.headers);
  const said = typeof reason === 'string' && reason.trim() ? reason.trim() : 'Not given';

  await notifyAdmins({
    subject: 'Account deactivated',
    message: `${who?.username || email || userId} paused their own account.`,
    details: [
      `Account: ${email || userId}`,
      who?.name ? `Name: ${who.name}` : '',
      who?.username ? `Username: ${who.username}` : '',
      'Who: the account holder, from a signed-in browser',
      `Reason: ${said}`,
      `When: ${new Date().toISOString()}`,
      device ? `Device: ${device}` : '',
      place ? `Location: ${place}` : '',
      ip ? `Address: ${ip}` : '',
    ].filter(Boolean).join('\n'),
    severity: 'info',
  }).catch(() => {});
}
