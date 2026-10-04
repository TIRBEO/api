import type { NextRequest } from 'next/server';
import { passkeyRegisterOptionsHandler } from '@/features/auth/passkeyHandlers';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  return passkeyRegisterOptionsHandler(req);
}
