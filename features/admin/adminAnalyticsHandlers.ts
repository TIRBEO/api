import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requirePermission } from '@/features/auth/http-guards';

export async function analyticsHandler(request: NextRequest) {
  const session = await requirePermission(request, 'analytics.read');
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
    prisma.user.count({ where: { isAdmin: true } }),
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
      include: { user: { select: { id: true, email: true, profile: { select: { name: true } } } } },
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
    recentAudit: recentAudit.map((l: any) => ({ ...l, actor: l.user ? { ...l.user, name: l.user.profile?.name ?? null } : l.user })),
    usersByDay,
    activityByDay,
  });
}

// ─── Admin: Get users who consented to analytics + their data ─────
export async function adminAnalyticsConsentedUsersHandler(request: NextRequest) {
  const session = await requirePermission(request, 'analytics.read');
  if (session instanceof NextResponse) return session;

  const url = new URL(request.url);
  const take = Math.min(parseInt(url.searchParams.get('take') || '50', 10) || 50, 200);
  const skip = parseInt(url.searchParams.get('skip') || '0', 10) || 0;

  // Find all users with allowAnalytics=true
  const users = await prisma.user.findMany({
    where: {
      preferences: { is: { misc: { path: ['consents', 'allowAnalytics'], equals: true } } },
    },
    select: {
      id: true,
      email: true,
      username: true,
      createdAt: true,
      lastLoginAt: true,
      profile: { select: { name: true } },
      preferences: { select: { misc: true, appearance: true } },
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
      preferences: { is: { misc: { path: ['consents', 'allowAnalytics'], equals: true } } },
    },
  });

  // Enrich with login history summary for consented users. login_history and
  // SecurityEvent were both consolidated into ActivityEvent (eventType → kind):
  // a sign-in is a 'login'/'login_failed' row under the legacy names and an
  // 'auth.*' row under the current ones, so the filter covers BOTH shapes to
  // keep historical data counting (mirrors the admin dash's ALL_LOGIN_KINDS).
  const LOGIN_KINDS = [
    'login', 'login_failed',
    'auth.login_success', 'auth.login_2fa_success', 'auth.login_otp_success',
    'auth.login_recovery_2fa_success', 'auth.login_recovery_email_success',
    'auth.admin_login_success', 'auth.oauth_login', 'auth.passkey_login',
    'auth.otp_login', 'auth.recovery_login',
    'auth.login_failed', 'auth.oauth_failed', 'auth.passkey_login_failed',
    'auth.otp_login_failed', 'auth.recovery_login_failed', 'auth.admin_login_failed',
  ];
  const userIds = users.map(u => u.id);
  const recentLogins = userIds.length ? await prisma.activityEvent.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds }, kind: { in: LOGIN_KINDS } },
    _count: { id: true },
  }) : [];
  const loginMap = new Map(recentLogins.map(r => [r.userId, r._count.id]));

  const enriched = users.map(u => {
    const appearance = (u.preferences?.appearance ?? {}) as Record<string, any>;
    return {
      id: u.id,
      email: u.email,
      username: u.username,
      name: u.profile?.name ?? null,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      theme: appearance.theme ?? null,
      language: appearance.language ?? null,
      timezone: appearance.timezone ?? null,
      sessionCount: u._count.sessions,
      notificationCount: u._count.notifications,
      totalLogins: loginMap.get(u.id) || 0,
    };
  });

  return NextResponse.json({ users: enriched, total });
}
