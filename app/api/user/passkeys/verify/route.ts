import type { NextRequest } from 'next/server';
import { passkeyRegisterVerifyHandler } from '@/features/auth/passkeyHandlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Step two of adding a key: the authenticator's answer comes back here, and
    the credential is stored only if it checks out against the challenge. */
export async function POST(request: NextRequest) {
  return passkeyRegisterVerifyHandler(request);
}
