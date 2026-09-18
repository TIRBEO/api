import { NextRequest } from 'next/server';
import { limitsHandler, initLimitsHandler } from '@/features/auth/authHandlers';

export async function GET(request: NextRequest) {
  return limitsHandler(request);
}

export async function PUT(request: NextRequest) {
  return limitsHandler(request);
}

export async function POST(request: NextRequest) {
  const body: any = await request.json().catch(() => ({}));
  if (body?.action === 'init') {
    return initLimitsHandler();
  }
  return limitsHandler(request);
}
