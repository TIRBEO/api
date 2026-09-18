import { NextRequest } from 'next/server';
import { googleAuthRedirectHandler } from '@/features/auth/authHandlers';

export async function GET(request: NextRequest) {
  return googleAuthRedirectHandler(request);
}
