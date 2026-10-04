import type { NextRequest } from 'next/server';
import { passkeyRegisterVerifyHandler, passkeyAuthVerifyHandler } from '@/features/auth/passkeyHandlers';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body: any = await req.clone().json().catch(() => ({}));
  if (body?.mode === 'register') return passkeyRegisterVerifyHandler(req);
  return passkeyAuthVerifyHandler(req);
}
