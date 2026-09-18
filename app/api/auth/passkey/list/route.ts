import type { NextRequest } from 'next/server';
import { passkeyListHandler } from '@/features/auth/passkeyHandlers';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  return passkeyListHandler(req);
}
