import { prisma } from '@/infrastructure/db/prisma';
import { sendTemplateEmail } from '@/features/email/email';

interface MaintenanceNotificationOptions {
  title: string;
  message: string;
  startTime: Date;
  estimatedEnd?: Date | null;
  duration: string;
  notifyAll?: boolean;
  userIds?: string[];
}

interface MaintenanceCompleteOptions {
  title: string;
  completionMessage: string;
  completedAt: Date;
  duration: string;
  notifyAll?: boolean;
  userIds?: string[];
}

/** Resolve the recipient list for a maintenance send. */
async function resolveRecipients(options: { notifyAll?: boolean; userIds?: string[] }): Promise<{ id: string; email: string; name: string | null }[]> {
  if (options.userIds && options.userIds.length > 0) {
    return prisma.user.findMany({
      where: { id: { in: options.userIds } },
      select: { id: true, email: true, name: true },
    });
  }
  if (options.notifyAll) {
    return prisma.user.findMany({
      select: { id: true, email: true, name: true },
      take: 10000, // Safety limit
    });
  }
  return [];
}

/**
 * Batch-send a maintenance email to the resolved recipients, honouring each
 * user's own email preferences (sendTemplateEmail suppresses per-user).
 * Returns { sent, failed }.
 */
async function batchSend(
  users: { id: string; email: string; name: string | null }[],
  templateName: string,
  baseVars: Record<string, string>,
  notifTitle?: string,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  const batchSize = 50;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(user => sendTemplateEmail(user.email, templateName, { ...baseVars, name: user.name || 'User' })),
    );
    // Also deliver an in-app notification (DB + WebSocket) per user. The
    // dedicated maintenance template is the email channel (skipEmail avoids a
    // redundant notification_digest). In-app/push respect normal prefs.
    if (notifTitle) {
      await Promise.allSettled(
        batch.map(user => import('@/features/notifications/notifications').then(({ createNotification }) =>
          createNotification({
            userId: user.id,
            type: 'system',
            title: notifTitle,
            body: baseVars.maintenanceMessage || baseVars.completionMessage || '',
            link: '/home',
            skipEmail: true,
          }).catch(() => {}),
        )),
      );
    }
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) sent++;
      else failed++;
    }
    // Small delay between batches to avoid provider rate limits
    if (i + batchSize < users.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  return { sent, failed };
}

// Send maintenance notification to users
export async function sendMaintenanceNotification(options: MaintenanceNotificationOptions): Promise<{ sent: number; failed: number }> {
  const { title, message, startTime, estimatedEnd, duration, notifyAll = true, userIds } = options;

  const users = await resolveRecipients({ notifyAll, userIds });
  if (users.length === 0) return { sent: 0, failed: 0 };

  const result = await batchSend(users, 'maintenance_notification', {
    maintenanceTitle: title,
    maintenanceMessage: message,
    startTime: startTime.toLocaleString(),
    duration,
    estimatedEnd: estimatedEnd ? estimatedEnd.toLocaleString() : '',
  }, title);

  console.log(`[MAINTENANCE] Sent ${result.sent} maintenance notifications, ${result.failed} failed`);
  return result;
}

// Send maintenance complete notification
export async function sendMaintenanceCompleteNotification(options: MaintenanceCompleteOptions): Promise<{ sent: number; failed: number }> {
  const { title, completionMessage, completedAt, duration, notifyAll = true, userIds } = options;

  const users = await resolveRecipients({ notifyAll, userIds });
  if (users.length === 0) return { sent: 0, failed: 0 };

  const result = await batchSend(users, 'maintenance_complete', {
    maintenanceTitle: title,
    completionMessage,
    completedAt: completedAt.toLocaleString(),
    duration,
    dashboardUrl: process.env.NEXT_PUBLIC_DASHBOARD_URL || 'https://dashboard.tirbeo.app',
  }, title);

  console.log(`[MAINTENANCE] Sent ${result.sent} maintenance complete notifications, ${result.failed} failed`);
  return result;
}
