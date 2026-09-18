import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const session = await getSession(req);
    if (!session?.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      include: {
        notifications: { select: { id: true, type: true, title: true, body: true, createdAt: true } },
        sessions: { select: { id: true, createdAt: true, lastUsedAt: true } },
        passkeys: { select: { id: true, createdAt: true, updatedAt: true } },
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const exportData = {
      exportDate: new Date().toISOString(),
      profile: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        photoUrl: user.photoUrl,
        createdAt: user.createdAt,
      },
      notifications: user.notifications.map((n: any) => ({
        type: n.type,
        title: n.title,
        body: n.body,
        date: n.createdAt,
      })),
      sessions: user.sessions.map((s: any) => ({
        created: s.createdAt,
        lastUsed: s.lastUsedAt,
      })),
      passkeys: user.passkeys.length,
    };

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="tirbeo-data-export-${user.id.slice(0, 8)}.json"`,
      },
    });
  } catch (err: any) {
    console.error('[ACCOUNT EXPORT]', err?.message || err);
    return NextResponse.json({ error: 'Failed to export data' }, { status: 500 });
  }
}
