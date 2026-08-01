import { NextRequest } from 'next/server';
import { githubAuthCallbackHandler } from '../../../../lib/authHandlers';

export async function GET(request: NextRequest) {
  return githubAuthCallbackHandler(request);
}
