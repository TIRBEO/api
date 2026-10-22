import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { getUserPushSubscriptions } from '@/infrastructure/push/push-notifications';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;

    // The PushSubscription table is where subscribeToPush actually records a
    // browser; the prefs-blob key this used to read was never written, so the
    // list was empty even while push was delivering.
    const subscriptions = await getUserPushSubscriptions(session.userId);

    // Return sanitized list (no full subscription details for security)
    const items = subscriptions.map((sub: any) => ({
      id: sub.id,
      endpoint: sub.endpoint ? `${sub.endpoint.slice(0, 30)}...` : 'unknown',
      createdAt: sub.createdAt ? new Date(sub.createdAt).toISOString() : null,
      lastUsedAt: sub.lastUsedAt ? new Date(sub.lastUsedAt).toISOString() : null,
      userAgent: sub.userAgent || null,
    }));

    return NextResponse.json({ items, total: items.length });
  } catch (err: any) {
    console.error('[PUSHES] List error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch push subscriptions' }, { status: 500 });
  }
}
