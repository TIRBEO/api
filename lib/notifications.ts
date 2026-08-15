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

export type NotifType = 'security' | 'system' | 'digest' | 'admin_alert';

interface CreateNotifInput {
  userId: string;
  type: NotifType;
  title: string;
  body?: string;
  link?: string;
  icon?: string;
}

/**
 * Check if the current time is within the user's quiet hours window.
 * Quiet hours suppress email and push notifications but NOT the DB record
 * or real-time WebSocket delivery — the user just won't get external alerts.
 */
async function isInQuietHours(userId: string): Promise<boolean> {
  try {
    const prefs = await prisma.notificationPreference.findUnique({ where: { userId } });
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
      // Quiet window spans midnight: e.g., 22:00 → 08:00
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    } else {
      // Same-day quiet window: e.g., 12:00 → 14:00
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
  } catch {
    return false; // fail open — don't block notifications on errors
  }
}

export async function createNotification(input: CreateNotifInput) {
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

  // Send real-time notification via WebSocket (always — even during quiet hours)
  const notifData = { id: notif.id, userId: notif.userId, type: notif.type, title: notif.title, body: notif.body, link: notif.link, icon: notif.icon, read: false, createdAt: notif.createdAt.toISOString() };
  await sendToUserWs(input.userId, { type: 'notification', data: notifData });

  // Check quiet hours — suppress email during quiet window
  const quiet = await isInQuietHours(input.userId);

  if (!quiet) {
    // Send email if enabled
    const prefs = await prisma.notificationPreference.findUnique({ where: { userId: input.userId } });
    if (prefs?.email) {
      const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true, name: true } });
      if (user) {
        await sendTemplateEmail(user.email, 'notification_digest', {
          name: user.name || user.email,
          count: '1',
          digestItems: `<div class="item"><strong>${escapeHtml(input.title)}</strong><br/>${escapeHtml(input.body || '')}</div>`,
          dashboardUrl: input.link || 'https://tirbeo.app',
        }, { rawVars: ['digestItems'] }).catch(() => {});
      }
    }
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
