import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/features/auth/http-guards';
import { reactivateAccount } from '@/features/status/accountLifecycle';

export const runtime = 'nodejs';

/**
 * POST /api/user/reactivate — bring a paused account back.
 *
 * One path: the person is standing in the account's own session, on the
 * deactivated screen the settings gate put up, and presses Reactivate.
 *
 * There used to be a second, signed-out door here that mailed a 6-digit code
 * to an address and restored the account from it. It was retired: it answered
 * differently for "that address is paused" and "no such account", which is an
 * account-status oracle handed to anyone who asks, and it was never needed —
 * signing in again proves the same ownership better, and a closed account that
 * signs in is handed a session whose only room IS this button. Password
 * recovery already covers the person who cannot sign in.
 *
 * A scheduled deletion is undone by DELETE /api/user/delete-account, not here.
 * The proxy's closed-account door policy keeps both reachable.
 */
export async function POST(request: NextRequest) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json(
      { error: 'Sign in to reactivate this account.', code: 'auth_required' },
      { status: 401 },
    );
  }
  try {
    const result = await reactivateAccount(session.userId);
    const { bustProfileCache } = await import('@/features/auth/authHandlers');
    bustProfileCache(session.userId);
    return NextResponse.json({ ok: true, status: result.status, restoredAs: 'reactivated', message: 'Account reactivated' });
  } catch (err: any) {
    console.error('[REACTIVATE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to reactivate account' }, { status: 500 });
  }
}
