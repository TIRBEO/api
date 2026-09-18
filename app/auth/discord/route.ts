import { NextRequest } from 'next/server';
import { discordAuthRedirectHandler } from '@/features/auth/authHandlers';

export async function GET(request: NextRequest) {
  return discordAuthRedirectHandler(request);
}
