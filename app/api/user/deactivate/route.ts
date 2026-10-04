import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/features/auth/http-guards';
import { jsonUnauthorized } from '@/shared/response';
import { deactivateAccount } from '@/features/status/accountLifecycle';

export const runtime = 'nodejs';

/**
 * POST /api/user/deactivate — pause the account (soft door).
 *
 * The account enters a distinct `deactivated` state. The current session is
 * kept alive so the person reaches the "deactivated" screen and can undo it in
 * place; every other session is revoked. New sign-ins are refused separately
 * (loginHandler + the proxy status gate). Requires a live session — the browser
 * sends the CSRF token on this write, so the edge rejects a forged one.
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

    return NextResponse.json({ ok: true, status: result.status, message: 'Account deactivated' });
  } catch (err: any) {
    console.error('[DEACTIVATE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to deactivate account' }, { status: 500 });
  }
}
