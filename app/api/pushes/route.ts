import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;

    // Get push subscriptions for current user from user_preferences
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { notificationPreferences: true },
    });

    const prefs: any = (user as any)?.notificationPreferences || {};
    const subscriptions = prefs.pushSubscriptions || [];

    // Return sanitized list (no full subscription details for security)
    const items = subscriptions.map((sub: any, i: number) => ({
      id: i,
      endpoint: sub.endpoint ? `${sub.endpoint.slice(0, 30)}...` : 'unknown',
      createdAt: sub.createdAt || null,
      userAgent: sub.userAgent || null,
      enabled: sub.enabled !== false,
    }));

    return NextResponse.json({ items, total: items.length });
  } catch (err: any) {
    console.error('[PUSHES] List error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch push subscriptions' }, { status: 500 });
  }
}
