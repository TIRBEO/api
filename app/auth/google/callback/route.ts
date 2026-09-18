import { NextRequest } from 'next/server';
import { googleAuthCallbackHandler } from '@/features/auth/authHandlers';

export async function GET(request: NextRequest) {
  return googleAuthCallbackHandler(request);
}
