import { NextRequest } from 'next/server';
import { githubAuthRedirectHandler } from '../../../lib/authHandlers';

export async function GET(request: NextRequest) {
  return githubAuthRedirectHandler(request);
}
