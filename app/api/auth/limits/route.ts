import { NextRequest } from 'next/server';
import { limitsHandler, initLimitsHandler } from '@/features/auth/authHandlers';
import { requireRole } from '@/features/auth/http-guards';

export async function GET(request: NextRequest) {
  return limitsHandler(request);
}

export async function PUT(request: NextRequest) {
  return limitsHandler(request);
}

export async function POST(request: NextRequest) {
  const body: any = await request.json().catch(() => ({}));
  if (body?.action === 'init') {
    // The path is public (the login page GETs it unauthenticated), so the
    // Redis seeding branch must prove its own caller — seeding is admin-only.
    const gate = await requireRole(request as any, 'admin');
    if (gate instanceof Response) return gate;
    return initLimitsHandler();
  }
  return limitsHandler(request);
}
