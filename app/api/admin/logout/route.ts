import { NextRequest, NextResponse } from 'next/server';
import { logoutHandler } from '@/features/auth/authHandlers';

/* POST /api/admin/logout — end the operator's session.

   Deliberately open to a request that carries no valid session: the one thing
   a browser with a dead or forged cookie still needs is the answer that clears
   it. Refusing that call is how a console ends up showing a signed-out operator
   as signed in. The handler is the same one every account app signs out with,
   so "logout" means one set of cookies cleared, in one place, everywhere. */
export async function POST(request: NextRequest) {
  try {
    return await logoutHandler(request);
  } catch (err: any) {
    console.error('[ADMIN LOGOUT]', err?.message || err);
    return NextResponse.json({ error: 'Logout failed' }, { status: 400 });
  }
}
