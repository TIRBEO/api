import type { NextRequest } from 'next/server';
import { blockedVerifyHandler } from '@/features/auth/blockedVerify';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  return blockedVerifyHandler(req);
}
