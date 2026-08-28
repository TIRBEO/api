import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { listNotifications, getUnreadCount, markAsRead, createNotification } from '../../../../lib/notifications';

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

// POST /api/admin/notifications — broadcast an alert to one or many users.
export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  let body: any;
  try { body = await request.json(); } catch { return new NextResponse('Invalid JSON', { status: 400 }); }
  const { title, body: msg, link, userIds } = body;
  if (!title || typeof title !== 'string') {
    return new NextResponse('title is required', { status: 400 });
  }

  const targets: string[] = Array.isArray(userIds) && userIds.length ? userIds : [];
  if (targets.length) {
    await Promise.all(targets.map(uid =>
      createNotification({ userId: uid, type: 'admin_alert', title, body: msg, link }).catch(() => {})
    ));
    return NextResponse.json({ ok: true, sentTo: targets.length });
  }

  // Broadcast to every user (paginated).
  const { prisma } = await import('../../../../lib/db/prisma');
  const BATCH = 200;
  let cursor: string | undefined = undefined;
  let sent = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch: { id: string }[] = await prisma.user.findMany({
      where: { ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: { id: true },
    });
    if (!batch.length) break;
    await Promise.all(batch.map((u: { id: string }) =>
      createNotification({ userId: u.id, type: 'admin_alert', title, body: msg, link }).catch(() => {})
    ));
    sent += batch.length;
    cursor = batch[batch.length - 1].id;
  }
  return NextResponse.json({ ok: true, broadcastTo: sent });
}

