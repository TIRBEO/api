import { NextRequest } from 'next/server';
import { discordAuthCallbackHandler } from '@/features/auth/authHandlers';

export async function GET(request: NextRequest) {
  return discordAuthCallbackHandler(request);
}
