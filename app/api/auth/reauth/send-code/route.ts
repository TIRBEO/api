import type { NextRequest } from 'next/server';
import { reauthSendCodeHandler } from '@/features/auth/reauth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  return reauthSendCodeHandler(req);
}
