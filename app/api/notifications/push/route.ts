import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getUserPushSubscriptions, sendPushNotification, isPushConfigured } from '@/lib/push-notifications';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;

    const subscriptions = await getUserPushSubscriptions(session.userId);
    
    return NextResponse.json({
      subscriptions: subscriptions.map((s: { id: string; endpoint: string; userAgent: string | null; lastUsedAt: Date | null; createdAt: Date }) => ({
        id: s.id,
        endpoint: s.endpoint.substring(0, 50) + '...',
        userAgent: s.userAgent,
        lastUsedAt: s.lastUsedAt,
        createdAt: s.createdAt,
      })),
      configured: isPushConfigured(),
    });
  } catch (err: any) {
    console.error('[PUSH] Get subscriptions error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch subscriptions' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;

    if (!isPushConfigured()) {
      return NextResponse.json({ error: 'Push notifications not configured' }, { status: 503 });
    }

    // Send test push notification
    const result = await sendPushNotification(session.userId, {
      title: '🔔 Test Notification',
      body: 'Push notifications are working! You will receive alerts for security updates, form submissions, and more.',
      url: '/dashboard/notifications',
      tag: 'test-notification',
    });

    return NextResponse.json({
      ok: true,
      sent: result.sent,
      failed: result.failed,
      message: result.sent > 0 ? 'Test notification sent!' : 'No push subscriptions found',
    });
  } catch (err: any) {
    console.error('[PUSH] Test notification error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to send test notification' }, { status: 500 });
  }
}
