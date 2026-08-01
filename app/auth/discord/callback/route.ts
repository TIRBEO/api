import { NextRequest } from 'next/server';
import { discordAuthCallbackHandler } from '../../../../lib/authHandlers';

export async function GET(request: NextRequest) {
  return discordAuthCallbackHandler(request);
}
