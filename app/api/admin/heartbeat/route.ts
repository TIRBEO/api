import { NextResponse } from 'next/server';
import { requireAdmin } from '@/features/auth/http-guards';

export async function POST(request: Request) {
  const session = await requireAdmin(request as any);
  if (session instanceof NextResponse) return session;

  return NextResponse.json({ ok: true });
}
