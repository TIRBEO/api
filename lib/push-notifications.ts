import { prisma } from './db/prisma';
import webPush from 'web-push';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// ─── VAPID Configuration ───

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@tirbeo.app';

function loadVapidKeys(): { publicKey: string; privateKey: string } {
  const envPublic = process.env.VAPID_PUBLIC_KEY || '';
  const envPrivate = process.env.VAPID_PRIVATE_KEY || '';
  if (envPublic && envPrivate) {
    return { publicKey: envPublic, privateKey: envPrivate };
  }

  // Fallback: generate once and persist so keys stay stable across restarts.
  const keyFile = join(process.cwd(), 'vapid-keys.json');
  try {
    if (existsSync(keyFile)) {
      const parsed = JSON.parse(readFileSync(keyFile, 'utf8'));
      if (parsed.publicKey && parsed.privateKey) {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    }
  } catch {}

  const keys = webPush.generateVAPIDKeys();
  try {
    writeFileSync(keyFile, JSON.stringify(keys, null, 2));
    console.warn('[PUSH] VAPID keys generated and saved to vapid-keys.json');
  } catch (err: any) {
    console.error('[PUSH] Failed to persist VAPID keys:', err?.message);
  }
  return keys;
}

const VAPID_KEYS = loadVapidKeys();
const VAPID_PUBLIC_KEY = VAPID_KEYS.publicKey;
const VAPID_PRIVATE_KEY = VAPID_KEYS.privateKey;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch (e: any) {
    console.warn('[PUSH] VAPID keys invalid, push notifications disabled:', e?.message);
  }
}

export function isPushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

// ─── Subscription Management ───

export async function subscribeToPush(
  userId: string,
  subscription: { endpoint: string; p256dh: string; auth: string },
  userAgent?: string
) {
  // Upsert subscription (endpoint is unique per user)
  const existing = await prisma.pushSubscription.findUnique({
    where: { userId_endpoint: { userId, endpoint: subscription.endpoint } },
  });

  if (existing) {
    return prisma.pushSubscription.update({
      where: { id: existing.id },
      data: { lastUsedAt: new Date(), userAgent },
    });
  }

  return prisma.pushSubscription.create({
    data: {
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      userAgent,
    },
  });
}

export async function unsubscribeFromPush(userId: string, endpoint: string) {
  return prisma.pushSubscription.deleteMany({
    where: { userId, endpoint },
  });
}

export async function getUserPushSubscriptions(userId: string) {
  return prisma.pushSubscription.findMany({
    where: { userId },
    orderBy: { lastUsedAt: 'desc' },
  });
}

// ─── Push Delivery ───

interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

export async function sendPushNotification(
  userId: string,
  payload: PushPayload
): Promise<{ sent: number; failed: number }> {
  if (!isPushConfigured()) {
    return { sent: 0, failed: 0 };
  }

  const subscriptions = await getUserPushSubscriptions(userId);
  if (subscriptions.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const pushPayload = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon || '/icons/notification.png',
    badge: payload.badge || '/icons/badge.png',
    url: payload.url || '/account/inbox',
    tag: payload.tag || 'tirbeo-notification',
    data: payload.data || {},
    timestamp: Date.now(),
  });

  let sent = 0;
  let failed = 0;
  const endpointsToRemove: string[] = [];

  for (const sub of subscriptions) {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        pushPayload,
        { TTL: 60 * 60 } // 1 hour TTL
      );
      sent++;

      // Update lastUsedAt
      await prisma.pushSubscription.update({
        where: { id: sub.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => {});
    } catch (err: any) {
      failed++;
      // If subscription is expired or invalid, remove it
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        endpointsToRemove.push(sub.endpoint);
      }
    }
  }

  // Clean up invalid subscriptions
  if (endpointsToRemove.length > 0) {
    await prisma.pushSubscription.deleteMany({
      where: { userId, endpoint: { in: endpointsToRemove } },
    });
  }

  return { sent, failed };
}

// ─── Broadcast Push ───

export async function broadcastPush(
  payload: PushPayload,
  filter?: { userIds?: string[] }
): Promise<{ total: number; sent: number; failed: number }> {
  const where: any = {};
  if (filter?.userIds?.length) {
    where.userId = { in: filter.userIds };
  }

  const subscriptions = await prisma.pushSubscription.findMany({ where });
  const total = subscriptions.length;

  if (total === 0) {
    return { total: 0, sent: 0, failed: 0 };
  }

  const pushPayload = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon || '/icons/notification.png',
    badge: payload.badge || '/icons/badge.png',
    url: payload.url || '/account/inbox',
    tag: payload.tag || 'tirbeo-broadcast',
    data: payload.data || {},
    timestamp: Date.now(),
  });

  let sent = 0;
  let failed = 0;
  const endpointsToRemove: { userId: string; endpoint: string }[] = [];

  for (const sub of subscriptions) {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        pushPayload,
        { TTL: 60 * 60 }
      );
      sent++;
    } catch (err: any) {
      failed++;
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        endpointsToRemove.push({ userId: sub.userId, endpoint: sub.endpoint });
      }
    }
  }

  // Clean up invalid subscriptions
  for (const { userId, endpoint } of endpointsToRemove) {
    await prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    }).catch(() => {});
  }

  return { total, sent, failed };
}

// ─── Notification Preferences ───

export async function getNotificationPrefs(userId: string) {
  let prefs = await prisma.notificationPreference.findUnique({
    where: { userId },
  });

  if (!prefs) {
    prefs = await prisma.notificationPreference.create({
      data: { userId },
    });
  }

  return prefs;
}

export async function updateNotificationPrefs(
  userId: string,
  data: Partial<{
    email: boolean;
    push: boolean;
    inApp: boolean;
    security: boolean;
    product: boolean;
    support: boolean;
  }>
) {
  await getNotificationPrefs(userId);
  return prisma.notificationPreference.update({
    where: { userId },
    data,
  });
}

// ─── Check if user wants push for this type ───

export async function shouldSendPush(userId: string, type: string): Promise<boolean> {
  const prefs = await getNotificationPrefs(userId);
  
  if (!prefs.push) return false;
  
  switch (type) {
    case 'security':
      return prefs.security !== false;
    case 'form':
    case 'mention':
    case 'comment':
      return true; // forms feature removed
    case 'product':
    case 'digest':
      return prefs.product !== false;
    case 'support':
      return prefs.support !== false;
    default:
      return true;
  }
}

// ─── Helper: Create notification + push ───

/** Check if current time is within user's quiet hours window */
async function isInQuietHours(userId: string): Promise<boolean> {
  try {
    const prefs = await prisma.notificationPreference.findUnique({ where: { userId } });
    if (!prefs?.quietHoursEnabled) return false;
    const now = new Date();
    const [startH, startM] = (prefs.quietHoursStart || '22:00').split(':').map(Number);
    const [endH, endM] = (prefs.quietHoursEnd || '08:00').split(':').map(Number);
    const mins = now.getHours() * 60 + now.getMinutes();
    const start = startH * 60 + startM;
    const end = endH * 60 + endM;
    if (start > end) return mins >= start || mins < end;
    return mins >= start && mins < end;
  } catch { return false; }
}

export async function createNotificationWithPush(input: {
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  icon?: string;
  push?: boolean;
  email?: boolean;
}) {
  // Create in-app notification (always)
  const notif = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body || null,
      link: input.link || null,
      icon: input.icon || null,
    },
  });

  // Check quiet hours — suppress push and email during quiet window
  const quiet = await isInQuietHours(input.userId);

  // Send push if enabled and not in quiet hours
  if (input.push !== false && !quiet) {
    const shouldPush = await shouldSendPush(input.userId, input.type);
    if (shouldPush) {
      await sendPushNotification(input.userId, {
        title: input.title,
        body: input.body || '',
        url: input.link || '/account/inbox',
        tag: `notif-${notif.id}`,
      }).catch(() => {});
    }
  }

  // Send email if enabled and not in quiet hours
  // If digest is ON, don't send individual emails — the digest job batches them
  if (input.email !== false && !quiet) {
    const prefs = await getNotificationPrefs(input.userId);
    if (prefs.email && !prefs.digestEnabled) {
      const { sendTemplateEmail } = await import('./email');
      const user = await prisma.user.findUnique({
        where: { id: input.userId },
        select: { email: true, name: true },
      });
      if (user) {
        const { getDashboardBaseUrl } = await import('./app-urls');
        await sendTemplateEmail(user.email, 'notification_digest', {
          name: user.name || user.email,
          count: '1',
          digestItems: `<div style="padding:16px;background:#f8f9fa;border-radius:8px;margin-bottom:12px;"><strong>${input.title}</strong><br/>${input.body || ''}</div>`,
          dashboardUrl: input.link || `${getDashboardBaseUrl()}/account/inbox`,
        }).catch(() => {});
      }
    }
  }

  return notif;
}
