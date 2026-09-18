import type { NextRequest } from 'next/server';
import { reauthVerifyHandler } from '@/features/auth/reauth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  return reauthVerifyHandler(req);
}
