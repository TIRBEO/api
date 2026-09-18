import type { NextRequest } from 'next/server';
import { passkeyReauthVerifyHandler } from '@/features/auth/passkeyHandlers';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  return passkeyReauthVerifyHandler(req);
}
