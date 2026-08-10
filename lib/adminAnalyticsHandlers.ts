import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { requireAdmin } from './session';

export async function analyticsHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    adminUsers,
    newToday,
    totalMedia,
    totalNotifications,
    totalAuditEvents,
    topActions,
    recentAudit,
    usersByDay,
    activityByDay,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { adminRole: { not: null } } }),
    prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.media.count(),
    prisma.notification.count(),
    // Audit events (last 30 days)
    prisma.auditEvent.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    // Top 10 actions (last 30 days)
    prisma.auditEvent.groupBy({
      by: ['action'],
      where: { createdAt: { gte: thirtyDaysAgo } },
      _count: { action: true },
      orderBy: { _count: { action: 'desc' } },
      take: 10,
    }),
    // Recent audit events (last 20)
    prisma.auditEvent.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { actor: { select: { id: true, email: true, name: true } } },
    }),
    // Users by day (last 30 days)
    prisma.user.groupBy({
      by: ['createdAt'],
      where: { createdAt: { gte: thirtyDaysAgo } },
      _count: { createdAt: true },
    }),
    // Activity by day (last 30 days)
    prisma.auditEvent.groupBy({
      by: ['createdAt'],
      where: { createdAt: { gte: thirtyDaysAgo } },
      _count: { createdAt: true },
    }),
  ]);

  return NextResponse.json({
    totalUsers,
    adminUsers,
    newToday,
    totalMedia,
    totalNotifications,
    auditByResult: {
      success: totalAuditEvents,
      failure: 0,
      totalWithResult: totalAuditEvents,
      total: totalAuditEvents,
    },
    topActions: topActions.map(a => ({ action: a.action, count: a._count.action })),
    recentAudit,
    usersByDay,
    activityByDay,
  });
}
