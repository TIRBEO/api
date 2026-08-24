import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { requireAdmin } from './session';
import { jsonUnauthorized, jsonForbidden } from './response';
import { createAuditEvent } from './audit';

const DEFAULT_ANALYTICS_SETTINGS = {
  // Analytics
  analyticsEnabled: true,
  crashReportsEnabled: true,
  personalizedRecommendations: false,
  // Discoverability
  searchEngineIndexing: true,
  directoryListing: true,
  // Data retention
  notificationRetentionDays: 30,
  sessionRetentionDays: 90,
  auditLogRetentionDays: 365,
  // Global privacy defaults
  defaultShowEmail: false,
  defaultShowPhone: false,
  defaultShowLocation: true,
  defaultShowOnlineStatus: true,
};

/** GET /api/admin/settings — list all admin settings */
export async function adminSettingsHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const settings = await prisma.setting.findMany({ orderBy: { group: 'asc' } });

  // Seed defaults if empty
  if (settings.length === 0) {
    const defaults = Object.entries(DEFAULT_ANALYTICS_SETTINGS);
    for (const [key, value] of defaults) {
      await prisma.setting.upsert({
        where: { key },
        update: {},
        create: {
          key,
          value: value as any,
          group: key.includes('analytics') || key.includes('crash') || key.includes('recommendation') ? 'analytics'
            : key.includes('search') || key.includes('directory') ? 'discoverability'
            : key.includes('retention') ? 'data-retention'
            : 'privacy',
          label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (s: string) => s.toUpperCase()).trim(),
          description: `Global default for ${key}`,
        },
      });
    }
    const seeded = await prisma.setting.findMany({ orderBy: { group: 'asc' } });
    return NextResponse.json(seeded);
  }

  return NextResponse.json(settings);
}

/** PATCH /api/admin/settings — update a setting */
export async function adminSettingsUpdateHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body: any = await request.json();
  const { key, value } = body;
  if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });

  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: {
      key,
      value,
      group: 'general',
      label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (s: string) => s.toUpperCase()).trim(),
    },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'ADMIN_SETTING_CHANGED',
    targetType: 'setting',
    targetId: key,
    metadata: { key, value },
  });

  return NextResponse.json({ ok: true, message: `Setting "${key}" updated` });
}

/** GET /api/admin/analytics/overview — platform-wide analytics for admin */
export async function adminAnalyticsOverviewHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const monthAgo = new Date(now.getTime() - 30 * 86400000);

  const [
    totalUsers,
    activeUsers,
    newToday,
    newThisWeek,
    newThisMonth,
    totalNotifications,
    unreadNotifications,
    totalTickets,
    openTickets,
    totalSessions,
    activeSessions,
    totalAuditEvents,
    totalApps,
    activeApiKeys,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { lastActiveAt: { gte: weekAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: monthAgo } } }),
    prisma.notification.count(),
    prisma.notification.count({ where: { isRead: false } }),
    prisma.ticket?.count().catch(() => 0) as Promise<number>,
    prisma.ticket?.count({ where: { status: 'open' } }).catch(() => 0) as Promise<number>,
    prisma.session?.count().catch(() => 0) as Promise<number>,
    prisma.session?.count({ where: { expiresAt: { gt: now } } }).catch(() => 0) as Promise<number>,
    prisma.auditEvent?.count({ where: { createdAt: { gte: monthAgo } } }).catch(() => 0) as Promise<number>,
    prisma.apps.count().catch(() => 0) as Promise<number>,
    prisma.apiKey.count({ where: { isActive: true, revokedAt: null } }).catch(() => 0) as Promise<number>,
  ]);

  return NextResponse.json({
    users: { total: totalUsers, active: activeUsers, newToday, newThisWeek, newThisMonth },
    notifications: { total: totalNotifications, unread: unreadNotifications },
    tickets: { total: totalTickets, open: openTickets },
    sessions: { total: totalSessions, active: activeSessions },
    auditEvents: { last30Days: totalAuditEvents },
    roles: { total: 0 },
    apps: { total: totalApps },
    apiKeys: { active: activeApiKeys },
  });
}
