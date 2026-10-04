import type { NextRequest } from 'next/server';
import { passkeyAuthOptionsHandler } from '@/features/auth/passkeyHandlers';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  return passkeyAuthOptionsHandler(req);
}
