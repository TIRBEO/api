import { NextRequest } from 'next/server';
import { githubAuthRedirectHandler } from '@/features/auth/authHandlers';

export async function GET(request: NextRequest) {
  return githubAuthRedirectHandler(request);
}
