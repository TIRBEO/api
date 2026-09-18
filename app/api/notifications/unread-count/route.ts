import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result: any[] = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS unread
      FROM notifications
      WHERE user_id = ${session.userId} AND is_read = false
    `;

    return NextResponse.json({ unread: result[0]?.unread ?? 0 });
  } catch (err: any) {
    console.error('[NOTIFICATIONS/UNREAD]', err?.message || err);
    return NextResponse.json({ unread: 0 });
  }
}
