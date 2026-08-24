import { prisma } from './db/prisma';
import { sendTemplateEmail, escapeHtml } from './email';

// WebSocket send - dynamically import to avoid circular deps and work in serverless
async function sendToUserWs(userId: string, data: unknown) {
  try {
    const { sendToUser } = await import('./ws/server');
    sendToUser(userId, data);
  } catch {
    // WS server not available (serverless or not started)
  }
}

export type NotifType = 'security' | 'system' | 'digest' | 'admin_alert' | 'login' | 'forms' | 'product' | 'support' | 'ticket';

/** Which preference category a notification type belongs to. */
export type NotifCategory = 'security' | 'forms' | 'product' | 'support';

const CATEGORY_BY_TYPE: Record<string, NotifCategory> = {
  security: 'security',
  login: 'security',
  forms: 'forms',
  product: 'product',
  support: 'support',
  ticket: 'support',
  system: 'product',
  digest: 'product',
  admin_alert: 'product',
  marketing: 'product',
};

export function notifCategory(type: string): NotifCategory {
  return CATEGORY_BY_TYPE[type?.toLowerCase()] || 'product';
}

interface CreateNotifInput {
  userId: string;
  type: NotifType;
  title: string;
  body?: string;
  link?: string;
  icon?: string;
  /** Structured details (ip, device, method…) shown in the inbox detail view. */
  metadata?: Record<string, unknown>;
}

/**
 * Check if the current time is within the user's quiet hours window.
 * Quiet hours suppress email and push notifications but NOT the DB record
 * or real-time WebSocket delivery — the user just won't get external alerts.
 */
async function isInQuietHours(prefs: { quietHoursEnabled?: boolean | null; quietHoursStart?: string | null; quietHoursEnd?: string | null } | null): Promise<boolean> {
  try {
    if (!prefs?.quietHoursEnabled) return false;

    const now = new Date();
    // Convert to user's local hour using their timezone offset
    const startStr = prefs.quietHoursStart || '22:00';
    const endStr = prefs.quietHoursEnd || '08:00';

    const [startH, startM] = startStr.split(':').map(Number);
    const [endH, endM] = endStr.split(':').map(Number);

    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Handle overnight quiet hours (e.g., 22:00 → 08:00)
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } catch {
    return false; // fail open — don't block notifications on errors
  }
}

const on = (v: boolean | null | undefined) => v !== false; // default ON

/** Human-readable device string from a raw user-agent, e.g. "Chrome on Windows". */
export function describeDevice(ua?: string | null): string {
  if (!ua) return 'an unknown device';
  const browser = /edg\//i.test(ua) ? 'Edge'
    : /opr\/|opera/i.test(ua) ? 'Opera'
    : /chrome|crios/i.test(ua) ? 'Chrome'
    : /firefox|fxios/i.test(ua) ? 'Firefox'
    : /safari/i.test(ua) ? 'Safari'
    : 'Browser';
  const os = /windows/i.test(ua) ? 'Windows'
    : /android/i.test(ua) ? 'Android'
    : /iphone|ipad|ipod/i.test(ua) ? 'iOS'
    : /mac os x|macintosh/i.test(ua) ? 'macOS'
    : /linux/i.test(ua) ? 'Linux'
    : 'Unknown OS';
  return `${browser} on ${os}`;
}

export function getClientIpFromRequest(request: { headers: Headers }): string {
  const xff = request.headers.get('x-forwarded-for') || '';
  const ip = xff.split(',')[0].trim() || request.headers.get('x-real-ip') || '';
  if (ip) return ip;
  try { return request.headers.get('cf-connecting-ip') || ''; } catch { return ''; }
}

/** Consistent timestamp for notification bodies, e.g. "Aug 24, 2026, 2:05 PM UTC". */
export function fmtNow(): string {
  return new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

export async function createNotification(input: CreateNotifInput) {
  const category = notifCategory(input.type);

  // Load preferences (defaults to all-on when no row exists).
  let prefs: any = null;
  try {
    prefs = await prisma.notificationPreference.findUnique({ where: { userId: input.userId } });
  } catch { /* fall through with defaults */ }

  const inAppOn = on(prefs?.inApp) && on(prefs?.[`${category}InApp`]) && on(prefs?.[category]);
  const emailOn = on(prefs?.email) && on(prefs?.[`${category}Email`]) && on(prefs?.[category]);
  const pushOn = on(prefs?.push) && on(prefs?.[`${category}Push`]) && on(prefs?.[category]);

  if (!inAppOn) return null; // user opted out of in-app for this category entirely

  const notif = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body || null,
      link: input.link || null,
      icon: input.icon || null,
      metadata: (input.metadata || {}) as any,
    },
  });

  // Send real-time notification via WebSocket (always — even during quiet hours)
  const notifData = { id: notif.id, userId: notif.userId, type: notif.type, title: notif.title, body: notif.body, link: notif.link, icon: notif.icon, read: false, createdAt: notif.createdAt.toISOString() };
  await sendToUserWs(input.userId, { type: 'notification', data: notifData });

  // External channels (email / push) respect quiet hours.
  if (!emailOn && !pushOn) return notif;
  const quiet = await isInQuietHours(prefs);
  if (quiet) return notif;

  if (emailOn) {
    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true, name: true } });
    if (user) {
      let dash = 'https://tirbeo.app';
      try { const { getDashboardBaseUrl } = await import('./app-urls'); dash = getDashboardBaseUrl(); } catch { /* keep fallback */ }
      await sendTemplateEmail(user.email, 'notification_digest', {
        name: user.name || user.email,
        count: '1',
        digestItems: `<div class="item"><strong>${escapeHtml(input.title)}</strong><br/>${escapeHtml(input.body || '')}</div>`,
        dashboardUrl: input.link ? `${dash}${input.link}` : dash,
      }, { rawVars: ['digestItems'] }).catch(() => {});
    }
  }

  if (pushOn) {
    try {
      const { sendPushNotification } = await import('./push-notifications');
      await sendPushNotification(input.userId, {
        title: input.title,
        body: input.body || '',
        url: input.link,
        icon: input.icon || undefined,
      });
    } catch { /* push not configured or failed — non-fatal */ }
  }

  return notif;
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, isRead: false } });
}

export async function listNotifications(userId: string, limit = 50, offset = 0) {
  const [items, total] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.notification.count({ where: { userId } }),
  ]);
  return { items, total };
}

export async function markAsRead(userId: string, notifId?: string) {
  if (notifId) {
    await prisma.notification.updateMany({ where: { id: notifId, userId }, data: { isRead: true } });
  } else {
    await prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
  }
}

export async function getOrCreatePrefs(userId: string) {
  let prefs = await prisma.notificationPreference.findUnique({ where: { userId } });
  if (!prefs) {
    prefs = await prisma.notificationPreference.create({
      data: { userId },
    });
  }
  return prefs;
}

export async function updatePrefs(userId: string, data: Record<string, unknown>) {
  await getOrCreatePrefs(userId);
  return prisma.notificationPreference.update({
    where: { userId },
    data: data as any,
  });
}

// Send real-time notification to a specific user via WebSocket
export async function sendRealtimeNotification(userId: string, notification: {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  icon?: string;
  read?: boolean;
  createdAt: string;
}) {
  await sendToUserWs(userId, { type: 'notification', data: notification });
}

// Broadcast notification to all online users
export async function broadcastNotification(notification: {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  icon?: string;
  read?: boolean;
  createdAt: string;
}) {
  try {
    const { broadcast } = await import('./ws/server');
    broadcast({ type: 'notification', data: notification });
  } catch {
    // WS server not available
  }
}

// Get list of online user IDs
export async function getOnlineUsers(): Promise<string[]> {
  try {
    const { getOnlineUserIds } = await import('./ws/server');
    return getOnlineUserIds();
  } catch {
    return [];
  }
}
