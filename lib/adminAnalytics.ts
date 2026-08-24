import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { requireAdmin } from './session';

/** GET /api/admin/analytics/overview — platform-wide counters */
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
    activeApiKeys,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { lastActiveAt: { gte: weekAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: monthAgo } } }),
    prisma.notification.count(),
    prisma.notification.count({ where: { isRead: false } }),
    prisma.ticket.count().catch(() => 0) as Promise<number>,
    prisma.ticket.count({ where: { status: 'open' } }).catch(() => 0) as Promise<number>,
    prisma.session.count().catch(() => 0) as Promise<number>,
    prisma.session.count({ where: { expiresAt: { gt: now } } }).catch(() => 0) as Promise<number>,
    prisma.auditEvent.count({ where: { createdAt: { gte: monthAgo } } }).catch(() => 0) as Promise<number>,
    prisma.apiKey.count({ where: { isActive: true, revokedAt: null } }).catch(() => 0) as Promise<number>,
  ]);

  return NextResponse.json({
    users: { total: totalUsers, active: activeUsers, newToday, newThisWeek, newThisMonth },
    notifications: { total: totalNotifications, unread: unreadNotifications },
    tickets: { total: totalTickets, open: openTickets },
    sessions: { total: totalSessions, active: activeSessions },
    auditEvents: { last30Days: totalAuditEvents },
    apps: { total: 0 },
    apiKeys: { active: activeApiKeys },
  });
}
