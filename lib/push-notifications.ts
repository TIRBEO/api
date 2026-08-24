// ═══ PUSH NOTIFICATIONS (Web Push / VAPID) ═══
// Uses in-memory store for subscriptions (ephemeral by nature — browser
// push tokens expire when the user clears data or unsubscribes).
// For production at scale, swap this with Redis or a dedicated DB table.

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@tirbeo.app';

let configured = false;
if (PUBLIC_KEY && PRIVATE_KEY) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const webpush = require('web-push');
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    configured = true;
  } catch (err) {
    console.error('[PUSH] Failed to configure web-push:', (err as any)?.message);
  }
}

interface PushSub {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
}

// In-memory store keyed by endpoint
const subsByEndpoint = new Map<string, PushSub>();
let nextId = 1;

function makeId(): string {
  return `push_${nextId++}_${Date.now()}`;
}

export function isPushConfigured(): boolean {
  return configured;
}

export function getVapidPublicKey(): string | null {
  return configured ? PUBLIC_KEY : null;
}

export async function getUserPushSubscriptions(userId: string): Promise<PushSub[]> {
  const result: PushSub[] = [];
  for (const sub of subsByEndpoint.values()) {
    if (sub.userId === userId) result.push(sub);
  }
  return result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function subscribeToPush(
  userId: string,
  subscription: { endpoint: string; p256dh: string; auth: string },
  userAgent?: string,
): Promise<{ id: string }> {
  const now = new Date();
  const existing = subsByEndpoint.get(subscription.endpoint);
  if (existing) {
    existing.userId = userId;
    existing.p256dh = subscription.p256dh;
    existing.auth = subscription.auth;
    existing.userAgent = userAgent || null;
    existing.lastUsedAt = now;
    return { id: existing.id };
  }
  const id = makeId();
  const sub: PushSub = {
    id,
    userId,
    endpoint: subscription.endpoint,
    p256dh: subscription.p256dh,
    auth: subscription.auth,
    userAgent: userAgent || null,
    createdAt: now,
    lastUsedAt: now,
  };
  subsByEndpoint.set(subscription.endpoint, sub);
  return { id };
}

export async function unsubscribeFromPush(userId: string, endpoint: string) {
  const sub = subsByEndpoint.get(endpoint);
  if (sub && sub.userId === userId) {
    subsByEndpoint.delete(endpoint);
  }
  return { ok: true };
}

/** Send a push to every device of a user. Stale endpoints (404/410) are pruned. */
export async function sendPushNotification(
  userIdOrSubscription: string | { endpoint: string; p256dh: string; auth: string },
  payload?: { title: string; body?: string; icon?: string; url?: string; tag?: string },
): Promise<{ sent: number; failed: number }> {
  if (!configured) return { sent: 0, failed: 0 };

  let subs: { endpoint: string; p256dh: string; auth: string; id?: string }[];
  if (typeof userIdOrSubscription === 'string') {
    subs = (await getUserPushSubscriptions(userIdOrSubscription)).map((s) => ({
      endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, id: s.id,
    }));
  } else {
    subs = [userIdOrSubscription];
  }
  if (subs.length === 0) return { sent: 0, failed: 0 };

  const webpush = require('web-push');
  let sent = 0;
  let failed = 0;

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({
          title: payload?.title || 'Tirbeo',
          body: payload?.body || '',
          icon: payload?.icon || '/icons/notification.png',
          badge: '/icons/badge.png',
          url: payload?.url || '/dashboard/notifications',
          tag: payload?.tag || 'tirbeo-notification',
          timestamp: Date.now(),
        }),
        { TTL: 3600 },
      );
      sent++;
      if (sub.id) {
        const stored = subsByEndpoint.get(sub.endpoint);
        if (stored) stored.lastUsedAt = new Date();
      }
    } catch (err: any) {
      failed++;
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        subsByEndpoint.delete(sub.endpoint);
      }
    }
  }));

  return { sent, failed };
}
