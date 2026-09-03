import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { requireAdmin } from '../../../../lib/session';
import { getRateLimitMetrics, getBlockRateAlerts } from '../../../../lib/auth/rate-limit';
import { getQueryPerformanceStats } from '../../../../lib/queryMonitor';
import { publicHealthHandler } from '../../../../lib/health';
import { getRedisHealthSummary } from '../../../../lib/db/redis';

function safe<T>(p: Promise<T>): Promise<T> {
  return p.catch(() => 0 as any);
}
function safeMany(p: Promise<any>): Promise<any> {
  return p.catch(() => []);
}
async function countPair(name: string, fn: () => Promise<number>): Promise<[string, number]> {
  return [name, await fn().catch(() => 0)];
}

const g = globalThis as any;
const CACHE_TTL = 5000; // recompute at most every 5s per process
if (!g.__adminDashCache) g.__adminDashCache = {};

/** GET /api/admin/dash — full-platform realtime telemetry for the M3 dashboard */
export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const rawDays = Number(request.nextUrl.searchParams.get('days')) || 14;
  const days = Math.min(90, Math.max(7, Math.round(rawDays)));

  const cached = g.__adminDashCache[days];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({ ...cached.data, cached: true });
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const monthAgo = new Date(now.getTime() - 30 * 86400000);

  /* ─────────────── All tables (counts) ─────────────── */
  const tableRows: [string, number][] = await Promise.all([
    countPair('user', () => prisma.user.count()),
    countPair('session', () => prisma.session.count()),
    countPair('deviceAccount', () => prisma.deviceAccount.count()),
    countPair('otp', () => prisma.otp.count()),
    countPair('signupOtp', () => prisma.signupOtp.count()),
    countPair('apiKey', () => prisma.apiKey.count()),
    countPair('passkey', () => prisma.passkey.count()),
    countPair('userTipLog', () => prisma.userTipLog.count()),
    countPair('blocklist', () => prisma.blocklist.count()),
    countPair('securityEvent', () => prisma.securityEvent.count()),
    countPair('auditEvent', () => prisma.auditEvent.count()),
    countPair('loginHistory', () => prisma.login_history.count()),
    countPair('notification', () => prisma.notification.count()),
    countPair('pushSubscription', () => prisma.pushSubscription.count()),
    countPair('media', () => prisma.media.count()),
    countPair('emailConfig', () => prisma.emailConfig.count()),
    countPair('emailTemplate', () => prisma.emailTemplate.count()),
    countPair('emailLog', () => prisma.email_logs.count()),
    countPair('captchaChallenge', () => prisma.captchaChallenge.count()),
    countPair('captchaAttempt', () => prisma.captchaAttempt.count()),
    countPair('captchaBlock', () => prisma.captchaBlock.count()),
    countPair('captchaLog', () => prisma.captchaLog.count()),
    countPair('captchaSettings', () => prisma.captchaSettings.count()),
    countPair('incidentEvent', () => prisma.incident_events.count()),
    countPair('form', () => prisma.form.count()),
    countPair('formField', () => prisma.formField.count()),
    countPair('formSubmission', () => prisma.formSubmission.count()),
    countPair('formAnalytic', () => prisma.formAnalytic.count()),
    countPair('formConnection', () => prisma.formConnection.count()),
    countPair('ticket', () => prisma.ticket.count()),
    countPair('ticketMessage', () => prisma.ticketMessage.count()),
    countPair('ticketAttachment', () => prisma.ticket_attachments.count()),
  ]);
  const tables = Object.fromEntries(tableRows);

  /* ─────────────── Featured overview counters ─────────────── */
  const [
    activeUsers, activeUsersToday, newToday, newThisWeek, newThisMonth,
    verifiedEmail, verifiedPhone, banned, suspended, scheduledDeletion, deleted, twoFA, mustChange,
    totalNotifications, unreadNotifications,
    totalTickets, openTickets,
    activeSessions,
    activeApiKeys,
    emailsToday, emailsLastHour, emailFailures, emailsOpened, emailsClicked,
    loginsToday, failedLoginsToday,
    securityEventsToday,
    totalSubmissions, submissionsToday,
    mediaToday,
    captchaChallenges, captchaSolved, captchaAttempts, captchaBlocks, captchaActiveBlocks, captchaLogs,
    incidentCount, incidentToday,
    pushSubs,
  ] = await Promise.all([
    safe(prisma.user.count({ where: { lastActiveAt: { gte: weekAgo } } })),
    safe(prisma.user.count({ where: { lastActiveAt: { gte: dayAgo } } })),
    safe(prisma.user.count({ where: { createdAt: { gte: todayStart } } })),
    safe(prisma.user.count({ where: { createdAt: { gte: weekAgo } } })),
    safe(prisma.user.count({ where: { createdAt: { gte: monthAgo } } })),
    safe(prisma.user.count({ where: { emailVerified: true } })),
    safe(prisma.user.count({ where: { phoneVerified: true } })),
    safe(prisma.user.count({ where: { isBanned: true } })),
    safe(prisma.user.count({ where: { isSuspended: true } })),
    safe(prisma.user.count({ where: { scheduledDeletionAt: { not: null } } })),
    safe(prisma.user.count({ where: { deletedAt: { not: null } } })),
    safe(prisma.user.count({ where: { is2FAEnabled: true } })),
    safe(prisma.user.count({ where: { mustChangePassword: true } })),
    safe(prisma.notification.count()),
    safe(prisma.notification.count({ where: { isRead: false } })),
    safe(prisma.ticket.count()),
    safe(prisma.ticket.count({ where: { status: 'open' } })),
    safe(prisma.session.count({ where: { expiresAt: { gt: now } } })),
    safe(prisma.apiKey.count({ where: { isActive: true, revokedAt: null } })),
    safe(prisma.email_logs.count({ where: { createdAt: { gte: todayStart } } })),
    safe(prisma.email_logs.count({ where: { createdAt: { gte: hourAgo } } })),
    safe(prisma.email_logs.count({ where: { status: 'failed' } })),
    safe(prisma.email_logs.count({ where: { openedAt: { not: null } } })),
    safe(prisma.email_logs.count({ where: { clickedAt: { not: null } } })),
    safe(prisma.login_history.count({ where: { createdAt: { gte: todayStart } } })),
    safe(prisma.login_history.count({ where: { createdAt: { gte: todayStart }, success: false } })),
    safe(prisma.securityEvent.count({ where: { createdAt: { gte: todayStart }, severity: { in: ['warning', 'error', 'critical'] } } })),
    safe(prisma.formSubmission.count()),
    safe(prisma.formSubmission.count({ where: { createdAt: { gte: todayStart } } })),
    safe(prisma.media.count({ where: { createdAt: { gte: todayStart } } })),
    safe(prisma.captchaChallenge.count()),
    safe(prisma.captchaChallenge.count({ where: { solved: true } })),
    safe(prisma.captchaAttempt.count()),
    safe(prisma.captchaBlock.count()),
    safe(prisma.captchaBlock.count({ where: { unblockedAt: null } })),
    safe(prisma.captchaLog.count()),
    safe(prisma.incident_events.count()),
    safe(prisma.incident_events.count({ where: { createdAt: { gte: todayStart } } })),
    safe(prisma.pushSubscription.count()),
  ]);

  /* ─────────────── Group-by breakdowns ─────────────── */
  const [
    adminsByRole, oauth, sessionsByStatus, apiKeysByState, notificationsByType,
    securityBySeverity, securityTopTypes, auditBySeverity, auditToday, loginByMethod,
    emailByStatus, emailTopTemplates, ticketByStatus, ticketByPriority, ticketByCategory,
    ticketMessages, ticketAttachments, formByStatus, submissionByStatus, formFields, formConnections,
    formAnalyticAgg, mediaByMime, incidentBySeverity, incidentBySource,
  ] = await Promise.all([
    safeMany(prisma.user.groupBy({ by: ['adminRole'], where: { adminRole: { not: null } }, _count: { adminRole: true } })),
    Promise.all([
      safe(prisma.user.count({ where: { googleId: { not: null } } })),
      safe(prisma.user.count({ where: { githubId: { not: null } } })),
      safe(prisma.user.count({ where: { discordId: { not: null } } })),
    ]),
    safeMany(prisma.session.groupBy({ by: ['status'], _count: { status: true } })),
    safeMany(prisma.apiKey.groupBy({ by: ['isActive'], _count: { isActive: true } })),
    safeMany(prisma.notification.groupBy({ by: ['type'], _count: { type: true } })),
    safeMany(prisma.securityEvent.groupBy({ by: ['severity'], _count: { severity: true } })),
    safeMany(prisma.securityEvent.groupBy({ by: ['eventType'], orderBy: { _count: { eventType: 'desc' } }, take: 8, _count: { eventType: true } })),
    safeMany(prisma.auditEvent.groupBy({ by: ['severity'], _count: { severity: true } })),
    safe(prisma.auditEvent.count({ where: { createdAt: { gte: todayStart } } })),
    safeMany(prisma.login_history.groupBy({ by: ['method'], _count: { method: true } })),
    safeMany(prisma.email_logs.groupBy({ by: ['status'], _count: { status: true } })),
    safeMany(prisma.email_logs.groupBy({ by: ['template'], orderBy: { _count: { template: 'desc' } }, take: 8, _count: { template: true } })),
    safeMany(prisma.ticket.groupBy({ by: ['status'], _count: { status: true } })),
    safeMany(prisma.ticket.groupBy({ by: ['priority'], _count: { priority: true } })),
    safeMany(prisma.ticket.groupBy({ by: ['category'], _count: { category: true } })),
    safe(prisma.ticketMessage.count()),
    safe(prisma.ticket_attachments.count()),
    safeMany(prisma.form.groupBy({ by: ['status'], _count: { status: true } })),
    safeMany(prisma.formSubmission.groupBy({ by: ['status'], _count: { status: true } })),
    safe(prisma.formField.count()),
    safe(prisma.formConnection.count()),
    safeMany(prisma.formAnalytic.aggregate({ _sum: { views: true, starts: true, submissions: true, avgCompletionTime: true } })),
    safeMany(prisma.media.groupBy({ by: ['mimeType'], _count: { mimeType: true } })),
    safeMany(prisma.incident_events.groupBy({ by: ['severity'], _count: { severity: true } })),
    safeMany(prisma.incident_events.groupBy({ by: ['source'], _count: { source: true } })),
  ]);

  /* ─────────────── Time series (configurable range) ─────────────── */
  const dayBuckets = Array.from({ length: days }, (_, i) => {
    const d = new Date(now.getTime() - (days - 1 - i) * 86400000);
    return { start: new Date(d.getFullYear(), d.getMonth(), d.getDate()), label: `${d.getMonth() + 1}/${d.getDate()}` };
  });
  const seriesStart = dayBuckets[0].start;

  const [
    activityByDay, emailByDay, loginByDay, userByDay, securityByDay,
    ticketByDay, notificationByDay, submissionByDay, incidentByDay, mediaByDay,
  ] = await Promise.all([
    safeMany(prisma.auditEvent.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    safeMany(prisma.email_logs.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    safeMany(prisma.login_history.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    safeMany(prisma.user.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    safeMany(prisma.securityEvent.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    safeMany(prisma.ticket.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    safeMany(prisma.notification.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    safeMany(prisma.formSubmission.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    safeMany(prisma.incident_events.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    safeMany(prisma.media.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
  ]);

  const bucketOf = (rows: any[]) => {
    const map = new Map<number, number>();
    for (const r of rows) {
      const d = r.createdAt as Date;
      const k = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      map.set(k, (map.get(k) || 0) + (r._count?.createdAt ?? 1));
    }
    return dayBuckets.map((b) => ({ label: b.label, value: map.get(b.start.getTime()) || 0 }));
  };

  /* ─────────────── Top actions + recents ─────────────── */
  const [topActions, recentAudit, recentEmails, recentLogins, recentSecurity,
    recentTickets, recentNotifications, recentSubmissions, recentIncidents, recentCaptcha] = await Promise.all([
    safeMany(prisma.auditEvent.groupBy({ by: ['action'], where: { createdAt: { gte: monthAgo } }, _count: { action: true }, orderBy: { _count: { action: 'desc' } }, take: 10 })),
    safeMany(prisma.auditEvent.findMany({ where: { createdAt: { gte: weekAgo } }, orderBy: { createdAt: 'desc' }, take: 20, include: { actor: { select: { id: true, email: true, name: true } } } })),
    safeMany(prisma.email_logs.findMany({ orderBy: { createdAt: 'desc' }, take: 15, select: { id: true, toEmail: true, subject: true, template: true, status: true, openedAt: true, clickedAt: true, createdAt: true } })),
    safeMany(prisma.login_history.findMany({ orderBy: { createdAt: 'desc' }, take: 15, select: { id: true, email: true, ipAddress: true, success: true, method: true, createdAt: true } })),
    safeMany(prisma.securityEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 15, select: { id: true, eventType: true, severity: true, ipAddress: true, userId: true, createdAt: true } })),
    safeMany(prisma.ticket.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, subject: true, status: true, priority: true, createdAt: true, customer: { select: { email: true, name: true } } } })),
    safeMany(prisma.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, type: true, title: true, isRead: true, createdAt: true } })),
    safeMany(prisma.formSubmission.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, status: true, ipAddress: true, createdAt: true, form: { select: { name: true } } } })),
    safeMany(prisma.incident_events.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, type: true, severity: true, source: true, message: true, createdAt: true } })),
    safeMany(prisma.captchaBlock.findMany({ orderBy: { blockedAt: 'desc' }, take: 8, select: { id: true, ipAddress: true, reason: true, difficulty: true, unblockedAt: true, blockedAt: true } })),
  ]);

  /* ─────────────── Runtime metrics + health ─────────────── */
  const rateLimits = getRateLimitMetrics();
  const blockAlerts = getBlockRateAlerts();
  const queryPerfRaw = getQueryPerformanceStats();
  const healthRes = await (publicHealthHandler() as any).catch(() => null);
  const health = healthRes && healthRes.json ? await healthRes.json().catch(() => null) : null;
  const redisSummary = getRedisHealthSummary();

  const slowest = Object.entries(queryPerfRaw.queries)
    .map(([name, s]: [string, any]) => ({ name, p95Ms: Math.round(s.p95Ms), maxMs: s.maxMs, count: s.count, avgMs: s.count ? Math.round(s.totalMs / s.count) : 0 }))
    .sort((a, b) => b.p95Ms - a.p95Ms)
    .slice(0, 12);

  const loginsSuccessToday = loginsToday - failedLoginsToday;

  const [revokedKeys, expiredKeys] = await Promise.all([
    safe(prisma.apiKey.count({ where: { revokedAt: { not: null } } })),
    safe(prisma.apiKey.count({ where: { expiresAt: { lt: now }, revokedAt: null } })),
  ]);

  const body = {
    fetchedAt: now.toISOString(),
    cached: false,
    uptime: process.uptime(),
    overview: {
      users: { total: tables.user, active: activeUsers, activeToday: activeUsersToday, newToday, newThisWeek, newThisMonth },
      notifications: { total: totalNotifications, unread: unreadNotifications },
      tickets: { total: totalTickets, open: openTickets },
      sessions: { total: tables.session, active: activeSessions },
      auditEvents30d: tables.auditEvent,
      apiKeys: { active: activeApiKeys },
      emails: { total: tables.emailLog, today: emailsToday, lastHour: emailsLastHour, failures: emailFailures },
      logins: { total: tables.loginHistory, today: loginsToday },
      securityEventsToday,
      media: tables.media,
      forms: { total: tables.form, submissions: totalSubmissions },
      requests: { hits: rateLimits.totalHits, blocked: rateLimits.totalBlocked, bypassed: rateLimits.totalBypassed, blockRate: rateLimits.blockRate, trackedQueries: queryPerfRaw.totalTrackedQueries },
    },
    tables,
    users: {
      total: tables.user, active: activeUsers, activeToday: activeUsersToday, newToday, newThisWeek, newThisMonth,
      verifiedEmail, verifiedPhone, banned, suspended, scheduledDeletion, deleted, twoFA, mustChange,
      admins: adminsByRole.map((r: any) => ({ role: r.adminRole || 'admin', count: r._count.adminRole ?? 0 })),
      oauth: { google: oauth[0], github: oauth[1], discord: oauth[2] },
    },
    sessions: { total: tables.session, active: activeSessions, byStatus: sessionsByStatus.map((s: any) => ({ status: s.status || 'unknown', count: s._count.status ?? 0 })) },
    apiKeys: { total: tables.apiKey, active: activeApiKeys, revoked: revokedKeys, expired: expiredKeys },
    notifications: {
      total: totalNotifications, unread: unreadNotifications,
      byType: notificationsByType.map((n: any) => ({ type: n.type || 'other', count: n._count.type ?? 0 })),
    },
    security: {
      total: tables.securityEvent, today: securityEventsToday,
      bySeverity: securityBySeverity.map((s: any) => ({ severity: s.severity ?? 'info', count: s._count.severity ?? 0 })),
      topTypes: securityTopTypes.map((s: any) => ({ eventType: s.eventType || 'unknown', count: s._count.eventType ?? 0 })),
    },
    auditInfo: { total30d: tables.auditEvent, today: auditToday, bySeverity: auditBySeverity.map((s: any) => ({ severity: s.severity ?? 'info', count: s._count.severity ?? 0 })) },
    logins: {
      total: tables.loginHistory, today: loginsToday, successToday: loginsSuccessToday, failedToday: failedLoginsToday,
      successRateToday: loginsToday ? Math.round((loginsSuccessToday / loginsToday) * 100) : 100,
      byMethod: loginByMethod.map((l: any) => ({ method: l.method || 'unknown', count: l._count.method ?? 0 })),
    },
    emails: {
      total: tables.emailLog, today: emailsToday, lastHour: emailsLastHour, failures: emailFailures,
      opened: emailsOpened, clicked: emailsClicked,
      openRate: tables.emailLog ? Math.round((emailsOpened / tables.emailLog) * 100) : 0,
      clickRate: tables.emailLog ? Math.round((emailsClicked / tables.emailLog) * 100) : 0,
      topTemplates: emailTopTemplates.map((e: any) => ({ template: e.template || 'unknown', count: e._count.template ?? 0 })),
      byStatus: emailByStatus.map((e: any) => ({ status: e.status || 'unknown', count: e._count.status ?? 0 })),
    },
    tickets: {
      total: totalTickets, open: openTickets,
      closed: (ticketByStatus.find((t: any) => t.status === 'closed')?._count.status) ?? 0,
      resolved: (ticketByStatus.find((t: any) => t.status === 'resolved')?._count.status) ?? 0,
      byStatus: ticketByStatus.map((t: any) => ({ status: t.status || 'open', count: t._count.status ?? 0 })),
      byPriority: ticketByPriority.map((t: any) => ({ priority: t.priority || 'normal', count: t._count.priority ?? 0 })),
      byCategory: ticketByCategory.map((t: any) => ({ category: t.category || 'general', count: t._count.category ?? 0 })),
      messages: ticketMessages, attachments: ticketAttachments,
    },
    forms: {
      total: tables.form, submissions: totalSubmissions, submissionsToday, fields: formFields, connections: formConnections,
      views: formAnalyticAgg?._sum?.views ?? 0, starts: formAnalyticAgg?._sum?.starts ?? 0,
      byStatus: formByStatus.map((f: any) => ({ status: f.status || 'draft', count: f._count.status ?? 0 })),
      submissionByStatus: submissionByStatus.map((s: any) => ({ status: s.status || 'new', count: s._count.status ?? 0 })),
    },
    media: {
      total: tables.media, today: mediaToday,
      byMime: mediaByMime.map((m: any) => ({ mimeType: m.mimeType || 'other', count: m._count.mimeType ?? 0 })),
    },
    captcha: {
      challenges: captchaChallenges, solved: captchaSolved, solvedRate: captchaChallenges ? Math.round((captchaSolved / captchaChallenges) * 100) : 100,
      attempts: captchaAttempts, blocks: captchaBlocks, activeBlocks: captchaActiveBlocks, logs: captchaLogs,
    },
    incidents: {
      total: incidentCount, today: incidentToday,
      bySeverity: incidentBySeverity.map((i: any) => ({ severity: i.severity ?? 'error', count: i._count.severity ?? 0 })),
      bySource: incidentBySource.map((i: any) => ({ source: i.source ?? 'client', count: i._count.source ?? 0 })),
    },
    push: { total: pushSubs },
    requests: rateLimits,
    queryPerf: { ...queryPerfRaw, slowest },
    alerts: blockAlerts,
    health: health || { status: 'unknown', checks: {} },
    redis: { summary: redisSummary },
    series: {
      activity: bucketOf(activityByDay),
      emails: bucketOf(emailByDay),
      logins: bucketOf(loginByDay),
      users: bucketOf(userByDay),
      security: bucketOf(securityByDay),
      tickets: bucketOf(ticketByDay),
      notifications: bucketOf(notificationByDay),
      submissions: bucketOf(submissionByDay),
      incidents: bucketOf(incidentByDay),
      media: bucketOf(mediaByDay),
    },
    topActions: topActions.map((a: any) => ({ action: a.action, count: a._count.action })),
    emailStatusBreakdown: emailByStatus,
    recentAudit,
    recentEmails,
    recentLogins,
    recentSecurity,
    recentTickets,
    recentNotifications,
    recentSubmissions,
    recentIncidents,
    recentCaptcha,
  };

  g.__adminDashCache[days] = { data: body, ts: Date.now() };
  return NextResponse.json(body);
}