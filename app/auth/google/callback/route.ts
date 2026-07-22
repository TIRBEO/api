import { NextRequest } from 'next/server';
import { googleAuthCallbackHandler } from '../../../../lib/authHandlers';

export async function GET(request: NextRequest) {
  return googleAuthCallbackHandler(request);
}
