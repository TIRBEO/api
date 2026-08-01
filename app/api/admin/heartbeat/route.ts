import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';

export async function POST(request: Request) {
  const session = await requireAdmin(request as any);
  if (session instanceof NextResponse) return session;

  return NextResponse.json({ ok: true });
}
