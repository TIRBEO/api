import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/features/auth/http-guards';
import { jsonUnauthorized } from '@/shared/response';
import { readAccountState } from '@/features/status/accountLifecycle';

export const runtime = 'nodejs';

/**
 * GET /api/user/account-state — the account's REAL lifecycle state, straight
 * from the brain.
 *
 * This is what replaces the browser-local flags the lock screens used to trust.
 * One read answers: is the account deactivated, is a deletion pending (and when
 * it lands), how many ways are there to sign in, and which apps are connected.
 * Every lock/deactivated/deletion-pending/restricted screen derives itself from
 * here, so it reflects the account rather than the device it happened to be
 * opened on.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const state = await readAccountState(session.userId);
    return NextResponse.json(state);
  } catch (err: any) {
    console.error('[ACCOUNT STATE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to read account state' }, { status: 500 });
  }
}
