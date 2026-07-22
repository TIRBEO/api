import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/session';
import { listNotifications, getUnreadCount, markAsRead } from '../../../../lib/notifications';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const sp = request.nextUrl.searchParams;
  const countOnly = sp.get('count') === 'true';
  if (countOnly) {
    const count = await getUnreadCount(session.userId);
    return NextResponse.json({ count });
  }

  const result = await listNotifications(session.userId, Number(sp.get('limit')) || 50, Number(sp.get('offset')) || 0);
  return NextResponse.json(result);
}

export async function PUT(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  await markAsRead(session.userId);
  return NextResponse.json({ ok: true });
}
