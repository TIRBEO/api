import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requireAdmin } from '@/features/auth/http-guards';

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
    prisma.notification.count(),
    // Audit events (last 30 days)
    prisma.activityEvent.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    // Top 10 actions (last 30 days)
    prisma.activityEvent.groupBy({
      by: ['kind'],
      where: { createdAt: { gte: thirtyDaysAgo } },
      _count: { kind: true },
      orderBy: { _count: { kind: 'desc' } },
      take: 10,
    }),
    // Recent audit events (last 20)
    prisma.activityEvent.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { user: { select: { id: true, email: true, name: true } } },
    }),
    // Users by day (last 30 days)
    prisma.user.groupBy({
      by: ['createdAt'],
      where: { createdAt: { gte: thirtyDaysAgo } },
      _count: { createdAt: true },
    }),
    // Activity by day (last 30 days)
    prisma.activityEvent.groupBy({
      by: ['createdAt'],
      where: { createdAt: { gte: thirtyDaysAgo } },
      _count: { createdAt: true },
    }),
  ]);

  return NextResponse.json({
    totalUsers,
    adminUsers,
    newToday,
    totalMedia: 0,
    totalNotifications,
    auditByResult: {
      success: totalAuditEvents,
      failure: 0,
      totalWithResult: totalAuditEvents,
      total: totalAuditEvents,
    },
    topActions: topActions.map(a => ({ action: a.kind, count: a._count.kind })),
    recentAudit: recentAudit.map((l: any) => ({ ...l, actor: l.user })),
    usersByDay,
    activityByDay,
  });
}

// ─── Admin: Get users who consented to analytics + their data ─────
export async function adminAnalyticsConsentedUsersHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const url = new URL(request.url);
  const take = Math.min(parseInt(url.searchParams.get('take') || '50', 10) || 50, 200);
  const skip = parseInt(url.searchParams.get('skip') || '0', 10) || 0;

  // Find all users with allowAnalytics=true
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { consents: { path: ['allowAnalytics'], equals: true } },
      ],
    },
    select: {
      id: true,
      email: true,
      username: true,
      name: true,
      createdAt: true,
      lastLoginAt: true,
      consents: true,
      theme: true,
      language: true,
      timezone: true,
      _count: {
        select: {
          sessions: true,
          notifications: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take,
    skip,
  });

  const total = await prisma.user.count({
    where: {
      OR: [
        { consents: { path: ['allowAnalytics'], equals: true } },
      ],
    },
  });

  // Enrich with login history summary for consented users (login_history was
  // merged into security_events: 'login' / 'login_failed').
  const userIds = users.map(u => u.id);
  const recentLogins = userIds.length ? await prisma.securityEvent.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds }, eventType: { in: ['login', 'login_failed'] } },
    _count: { id: true },
  }) : [];
  const loginMap = new Map(recentLogins.map(r => [r.userId, r._count.id]));

  const enriched = users.map(u => ({
    id: u.id,
    email: u.email,
    username: u.username,
    name: u.name,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    theme: u.theme,
    language: u.language,
    timezone: u.timezone,
    sessionCount: u._count.sessions,
    notificationCount: u._count.notifications,
    totalLogins: loginMap.get(u.id) || 0,
  }));

  return NextResponse.json({ users: enriched, total });
}
