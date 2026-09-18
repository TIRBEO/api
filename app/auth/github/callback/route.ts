import { NextRequest } from 'next/server';
import { githubAuthCallbackHandler } from '@/features/auth/authHandlers';

export async function GET(request: NextRequest) {
  return githubAuthCallbackHandler(request);
}
