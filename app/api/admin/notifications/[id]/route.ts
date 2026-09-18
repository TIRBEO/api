import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/features/auth/http-guards';
import { markAsRead } from '@/features/notifications/notifications';

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  await markAsRead(session.userId, id);
  return NextResponse.json({ ok: true });
}
