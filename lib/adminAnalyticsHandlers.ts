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
    totalReports,
    totalNotifications,
    reportsByStatus,
    auditBySeverity,
    topActions,
    recentAudit,
    usersByDay,
    activityByDay,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { adminRole: { not: null } } }),
    prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.media.count(),
    prisma.contentReport.count(),
    prisma.notification.count(),
    // Reports by status
    Promise.all([
      prisma.contentReport.count({ where: { status: 'pending' } }),
      prisma.contentReport.count({ where: { status: 'reviewed' } }),
      prisma.contentReport.count({ where: { status: 'dismissed' } }),
      prisma.contentReport.count({ where: { status: 'actioned' } }),
    ]),
    // Audit events by severity
    Promise.all([
      prisma.auditEvent.count({ where: { severity: 'info', createdAt: { gte: thirtyDaysAgo } } }),
      prisma.auditEvent.count({ where: { severity: 'warning', createdAt: { gte: thirtyDaysAgo } } }),
      prisma.auditEvent.count({ where: { severity: 'error', createdAt: { gte: thirtyDaysAgo } } }),
      prisma.auditEvent.count({ where: { severity: 'critical', createdAt: { gte: thirtyDaysAgo } } }),
    ]),
    // Top 10 actions (last 30 days)
    prisma.auditEvent.groupBy({
      by: ['action'],
      where: { createdAt: { gte: thirtyDaysAgo } },
      _count: { action: true },
      orderBy: { _count: { action: 'desc' } },
      take: 10,
    }),
    // Recent 10 audit events
    prisma.auditEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { actor: { select: { email: true, name: true } } },
    }),
    // User signups per day (last 30 days)
    prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
      SELECT DATE(created_at) as date, COUNT(*)::int as count
      FROM "User"
      WHERE created_at >= ${thirtyDaysAgo}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `,
    // Activity per day (heartbeats, last 30 days)
    prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
      SELECT DATE(created_at) as date, COUNT(*)::int as count
      FROM "Session"
      WHERE created_at >= ${thirtyDaysAgo}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `,
  ]);

  // Active users (DAU/WAU/MAU from sessions)
  const [dailyActive, weeklyActive, monthlyActive] = await Promise.all([
    prisma.session.count({
      where: { createdAt: { gte: todayStart } },
    }),
    prisma.session.count({
      where: { createdAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } },
    }),
    prisma.session.count({
      where: { createdAt: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } },
    }),
  ]);

  // Online now (active in last 5 min)
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const onlineNow = await prisma.user.count({ where: { lastActiveAt: { gte: fiveMinAgo } } });

  const fillDateRange = (
    data: Array<{ date: string; count: number }>,
    days: number
  ) => {
    const map = new Map(data.map(d => [d.date, d.count]));
    const result: Array<{ date: string; count: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      result.push({ date: key, count: map.get(key) || 0 });
    }
    return result;
  };

  return NextResponse.json({
    users: {
      total: totalUsers,
      admins: adminUsers,
      newToday,
      onlineNow,
      growth: fillDateRange(
        usersByDay.map((d: any) => ({ date: d.date instanceof Date ? d.date.toISOString().slice(0, 10) : String(d.date).slice(0, 10), count: Number(d.count) })),
        30
      ),
    },
    activity: {
      dailyActive,
      weeklyActive,
      monthlyActive,
      byDay: fillDateRange(
        activityByDay.map((d: any) => ({ date: d.date instanceof Date ? d.date.toISOString().slice(0, 10) : String(d.date).slice(0, 10), count: Number(d.count) })),
        30
      ),
    },
    content: {
      media: totalMedia,
      reports: totalReports,
      notifications: totalNotifications,
      reportsByStatus: {
        pending: reportsByStatus[0],
        reviewed: reportsByStatus[1],
        dismissed: reportsByStatus[2],
        actioned: reportsByStatus[3],
      },
    },
    audit: {
      bySeverity: {
        info: auditBySeverity[0],
        warning: auditBySeverity[1],
        error: auditBySeverity[2],
        critical: auditBySeverity[3],
      },
      topActions: topActions.map(a => ({ action: a.action, count: a._count.action })),
    },
    recentActivity: recentAudit.map(e => ({
      id: e.id,
      action: e.action,
      actor: e.actor ? (e.actor.name || e.actor.email) : 'System',
      severity: e.severity,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}
