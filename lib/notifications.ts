import { prisma } from './db/prisma';
import { sendTemplateEmail } from './email';

// WebSocket send - no-op in serverless (Vercel has no persistent connections)
function sendToUser(_userId: string, _data: unknown) {
  // In serverless, WebSocket connections don't persist between invocations.
  // This is handled by the client polling or using Server-Sent Events.
}

type NotifType = 'mention' | 'comment' | 'report' | 'system' | 'digest' | 'admin_alert';

interface CreateNotifInput {
  userId: string;
  type: NotifType;
  title: string;
  body?: string;
  link?: string;
  icon?: string;
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

  sendToUser(input.userId, {
    type: 'notification',
    data: { id: notif.id, userId: notif.userId, type: notif.type, title: notif.title, body: notif.body, link: notif.link, icon: notif.icon, read: false, createdAt: notif.createdAt.toISOString() },
  });

  const prefs = await prisma.notificationPreference.findUnique({ where: { userId: input.userId } });
  if (prefs?.emailDigest === 'instant') {
    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true, name: true } });
    if (user) {
      await sendTemplateEmail(user.email, 'notification_digest', {
        name: user.name || user.email,
        count: '1',
        digestItems: `<div class="item"><strong>${input.title}</strong><br/>${input.body || ''}</div>`,
        dashboardUrl: input.link || 'https://tirbeo.app',
      }).catch(() => {});
    }
  }

  return notif;
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, read: false } });
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
    await prisma.notification.updateMany({ where: { id: notifId, userId }, data: { read: true } });
  } else {
    await prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
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
