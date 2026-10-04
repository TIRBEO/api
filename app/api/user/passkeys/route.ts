import { NextRequest, NextResponse } from 'next/server';
import {
  passkeyDeleteHandler,
  passkeyListHandler,
  passkeyRegisterOptionsHandler,
} from '@/features/auth/passkeyHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* The settings app's own door to the credentials on the account. The ceremony
   itself lives in /api/auth/passkey/*, which the accounts app drives for
   sign-in; these are the same handlers, reached from a surface that only ever
   speaks for the signed-in user. */

export async function GET(request: NextRequest) {
  return passkeyListHandler(request);
}

/** Step one: the challenge the browser hands to the authenticator. */
export async function POST(request: NextRequest) {
  return passkeyRegisterOptionsHandler(request);
}

/** Revoking a key is a sensitive action, so the body carries an identity proof
    with it. That proof is read by the handler, which is why the id is taken
    from a copy of the request rather than from the request itself. */
export async function DELETE(request: NextRequest) {
  const body: any = await request.clone().json().catch(() => ({}));
  const passkeyId = typeof body?.passkeyId === 'string' ? body.passkeyId : '';
  if (!passkeyId) {
    return NextResponse.json({ error: 'Say which passkey to remove' }, { status: 400 });
  }
  return passkeyDeleteHandler(request, passkeyId);
}
