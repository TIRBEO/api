import { prisma } from '@/infrastructure/db/prisma';

/* Queue-side notification delivery: the enqueue path only persists the row and
   drops a signed envelope on Cloudflare Queues; everything slow (WS fan-out,
   Pusher, Beams/web-push, cache busts) runs here, off the request's critical
   path. Re-reading the row makes at-least-once delivery harmless — a duplicate
   drain finds the same state and re-sends idempotent channels. */

export async function deliverQueuedNotification(notificationId: string): Promise<void> {
  const notif = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!notif) return; // already deleted (user cleared it) — nothing to deliver

  const data = {
    id: notif.id,
    title: notif.title,
    body: notif.body,
    metadata: notif.metadata,
    createdAt: notif.createdAt.toISOString(),
  };

  const { sendToUserWs } = await import('@/infrastructure/realtime/ws-deliver');
  await sendToUserWs(notif.userId, { type: 'notification', data }).catch(() => {});

  try {
    const { pusherNotifyUser } = await import('@/infrastructure/realtime/pusher-deliver');
    pusherNotifyUser(notif.userId, 'notification', data);
  } catch { /* pusher lib unavailable */ }

  try {
    const { bustNotificationsCache } = await import('@/features/users/userHandlers');
    bustNotificationsCache?.(notif.userId);
  } catch { /* best effort */ }

  // External channels: the decision (prefs, quiet hours, rate limit) was made
  // at create time and stamped under metadata.__q — re-reading prefs here
  // could suppress what the user just asked for, or send what they opted out
  // of mid-flight. The stamped answer is the honest one.
  const meta = (notif.metadata ?? {}) as Record<string, unknown>;
  const q = (meta.__q ?? {}) as { push?: boolean; email?: boolean };
  if (q.push) {
    try {
      const { beamsNotifyUser } = await import('@/infrastructure/realtime/pusher-deliver');
      beamsNotifyUser?.(notif.userId, notif.title, String(notif.body ?? ''), String(meta.link ?? '/settings/notifications'));
    } catch { /* beams optional */ }
    void import('@/infrastructure/push/push-notifications').then((m) =>
      m.sendPushNotification(notif.userId, { title: notif.title, body: String(notif.body ?? ''), url: String(meta.link ?? '/settings/notifications'), tag: notif.type })
        .catch(() => {})).catch(() => {});
  }

  if (q.email) {
    try {
      const { primaryEmailForUser } = await import('@/features/notifications/notifications');
      const email = await primaryEmailForUser(notif.userId);
      if (email) {
        const { prisma: db } = await import('@/infrastructure/db/prisma');
        const user = await db.user.findUnique({ where: { id: notif.userId }, select: { profile: { select: { name: true } } } });
        const { getDashboardBaseUrl } = await import('@/config/app-urls');
        const base = getDashboardBaseUrl();
        const resolved = meta.link ? (/^https?:\/\//i.test(String(meta.link)) ? String(meta.link) : `${base}${meta.link}`) : `${base}/settings/notifications`;
        const { sendTemplateEmail, escapeHtml } = await import('@/features/email/email');
        const { cardItem } = await import('@/features/email/email-fragments');
        await sendTemplateEmail(email, 'notification_digest', {
          name: user?.profile?.name || email, count: '1',
          digestItems: cardItem(escapeHtml(notif.title), escapeHtml(String(notif.body ?? ''))),
          activitySection: '',
          dashboardUrl: resolved,
        }, { rawVars: ['digestItems', 'activitySection'], categoryOverride: String(meta.category ?? notif.type ?? 'product'), userId: notif.userId,
             metadata: { ...(meta.eventRefs as object ?? {}), notificationId: notif.id } });
      }
    } catch (err: any) {
      console.warn('[QUEUE] notify email leg failed:', err?.message || err);
    }
  }
}
