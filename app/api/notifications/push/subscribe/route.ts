import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { subscribeToPush, isPushConfigured, getVapidPublicKey } from '@/lib/push-notifications';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return NextResponse.json({
      configured: isPushConfigured(),
      publicKey: getVapidPublicKey(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to check push config' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;

    if (!isPushConfigured()) {
      return NextResponse.json({ error: 'Push notifications not configured' }, { status: 503 });
    }

    const body = await request.json();
    const { endpoint, p256dh, auth } = body;

    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json({ error: 'Missing subscription keys' }, { status: 400 });
    }

    const userAgent = request.headers.get('user-agent') || undefined;

    const subscription = await subscribeToPush(
      session.userId,
      { endpoint, p256dh, auth },
      userAgent
    );

    return NextResponse.json({ ok: true, subscription: { id: subscription.id } });
  } catch (err: any) {
    console.error('[PUSH] Subscribe error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to subscribe' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;

    const { endpoint } = await request.json();
    if (!endpoint) {
      return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 });
    }

    const { unsubscribeFromPush } = await import('@/lib/push-notifications');
    await unsubscribeFromPush(session.userId, endpoint);

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PUSH] Unsubscribe error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to unsubscribe' }, { status: 500 });
  }
}
