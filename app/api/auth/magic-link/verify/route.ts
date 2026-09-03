import { NextRequest } from 'next/server';
import { verifyMagicLinkHandler } from '../../../../../lib/authHandlers';

export async function GET(request: NextRequest) {
  return verifyMagicLinkHandler(request);
}

export async function POST(request: NextRequest) {
  return verifyMagicLinkHandler(request);
}
