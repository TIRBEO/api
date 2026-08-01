import { NextRequest } from 'next/server';
import { googleAuthRedirectHandler } from '../../../lib/authHandlers';

export async function GET(request: NextRequest) {
  return googleAuthRedirectHandler(request);
}
