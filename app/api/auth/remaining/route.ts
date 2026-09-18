import { NextRequest } from 'next/server';
import { remainingHandler } from '@/features/auth/authHandlers';

export async function GET(request: NextRequest) {
  return remainingHandler(request);
}
