import { NextRequest } from 'next/server';
import { discordAuthRedirectHandler } from '../../../lib/authHandlers';

export async function GET(request: NextRequest) {
  return discordAuthRedirectHandler(request);
}
