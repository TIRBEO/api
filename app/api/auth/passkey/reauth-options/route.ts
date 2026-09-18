import type { NextRequest } from 'next/server';
import { passkeyReauthOptionsHandler } from '@/features/auth/passkeyHandlers';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  return passkeyReauthOptionsHandler(req);
}
