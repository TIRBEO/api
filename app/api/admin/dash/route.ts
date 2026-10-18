import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requireAdmin } from '@/features/auth/http-guards';
import { getRateLimitMetrics, getBlockRateAlerts } from '@/features/auth/rate-limit';
import { getQueryPerformanceStats } from '@/infrastructure/observability/queryMonitor';
import { publicHealthHandler } from '@/features/observability/health';
import { getRedisHealthSummary } from '@/infrastructure/db/redis';
import { isTurnstileConfigured, getTurnstileSiteKey } from '@/features/auth/turnstile';

// One source of truth: every read below goes through activity_events. The
// legacy SecurityEvent model is no longer queried (its rows are historical,
// written before the ledger unified). LOGIN kind lists cover BOTH the
// pre-canonical names old rows carry ('login', 'login_failed') and the
// canonical auth-family kinds the handlers write today.
const LOGIN_SUCCESS_KINDS = [
  'login',
  'auth.login_success',
  'auth.login_2fa_success',
  'auth.login_otp_success',
  'auth.login_recovery_2fa_success',
  'auth.login_recovery_email_success',
  'auth.admin_login_success',
  'auth.oauth_login',
  'auth.passkey_login',
  'auth.otp_login',
  'auth.recovery_login',
];
const LOGIN_FAILED_KINDS = [
  'login_failed',
  'auth.log:verify',
  'auth.login_failed',
  'auth.oauth_failed',
  'auth.passkey_login_failed',
  'auth.otp_login_failed',
  'auth.recovery_login_failed',
];
const ALL_LOGIN_KINDS = [...LOGIN_SUCCESS_KINDS, ...LOGIN_FAILED_KINDS];

/** Captcha gate activity over the last 24h; all kinds, or one specific kind. */
function captchaGate24h(kind?: 'captcha.blocked' | 'captcha.attempt_failed') {
  return safe(
    prisma.activityEvent.count({
      where: {
        ...(kind ? { kind } : { kind: { in: ['captcha.blocked', 'captcha.attempt_failed'] } }),
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
  );
}

function safe<T>(p: Promise<T>): Promise<T> {
  return p.catch(() => 0 as any);
}
function safeMany(p: Promise<any>): Promise<any> {
  return p.catch(() => []);
}
async function countPair(name: string, fn: () => Promise<number>): Promise<[string, number]> {
  return [name, await fn().catch(() => 0)];
}

// OAuth-linked accounts now live in user_preferences.misc.oauth (a jsonb blob),
// not as columns on users. Count rows whose provider key is present. Provider
// name is code-controlled, so the `->` path is safe to interpolate as a param.
async function oauthConnected(provider: 'google' | 'github' | 'discord'): Promise<number> {
  const rows = await prisma.$queryRaw<[{ c: number }]>`SELECT COUNT(*)::int AS c FROM "public"."user_preferences" WHERE misc -> 'oauth' -> ${provider} IS NOT NULL`;
  return Number(rows[0]?.c ?? 0);
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
    countPair('session', () => prisma.userSession.count()),
    countPair('otp', () => prisma.otp.count()),
    countPair('emailDelivery', () => prisma.email_deliveries.count()),
    countPair('passkey', () => prisma.passkey.count()),
    countPair('userTipLog', () => prisma.userTipLog.count()),
    countPair('blocklist', () => prisma.blocklist.count()),
    countPair('securityEvent', () => prisma.activityEvent.count()),
    countPair('auditEvent', () => prisma.activityEvent.count()),
    countPair('loginHistory', () => prisma.activityEvent.count({ where: { kind: { in: ALL_LOGIN_KINDS } } })),
    countPair('notification', () => prisma.notification.count()),
    countPair('pushSubscription', () => prisma.pushSubscription.count()),
    countPair('media', () => Promise.resolve(0)),
    countPair('emailConfig', () => prisma.emailConfig.count()),
    countPair('emailTemplate', () => prisma.emailTemplate.count()),
    countPair('emailDelivery', () => prisma.email_deliveries.count()),
    countPair('incidentEvent', () => Promise.resolve(0)),
    countPair('form', () => Promise.resolve(0)),
    countPair('formField', () => Promise.resolve(0)),
    countPair('formSubmission', () => Promise.resolve(0)),
    countPair('formAnalytic', () => Promise.resolve(0)),
    countPair('formConnection', () => Promise.resolve(0)),
    countPair('ticket', () => Promise.resolve(0)),
    countPair('ticketMessage', () => Promise.resolve(0)),
    countPair('ticketAttachment', () => Promise.resolve(0)),
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
    safe(prisma.userEmail.count({ where: { AND: [{ OR: [{ kind: 'primary' }, { isDefault: true }] }, { verifiedAt: { not: null } }] } })),
    safe(prisma.userPhone.count({ where: { verifiedAt: { not: null } } })),
    safe(prisma.user.count({ where: { status: 'banned' } })),
    safe(prisma.user.count({ where: { status: 'suspended' } })),
    safe(prisma.user.count({ where: { status: 'deletion_pending' } })),
    safe(prisma.user.count({ where: { status: 'deleted' } })),
    safe(prisma.userSecurity.count({ where: { totpEnabled: true } })),
    safe(prisma.userSecurity.count({ where: { mustChangePw: true } })),
    safe(prisma.notification.count()),
    safe(prisma.notification.count({ where: { isRead: false } })),
    Promise.resolve(0),
    Promise.resolve(0),
    safe(prisma.userSession.count({ where: { expiresAt: { gt: now } } })),
    Promise.resolve(0),
    safe(prisma.email_deliveries.count({ where: { createdAt: { gte: todayStart } } })),
    safe(prisma.email_deliveries.count({ where: { createdAt: { gte: hourAgo } } })),
    safe(prisma.email_deliveries.count({ where: { status: 'failed' } })),
    safe(prisma.email_deliveries.count({ where: { openedAt: { not: null } } })),
    safe(prisma.email_deliveries.count({ where: { clickedAt: { not: null } } })),
    safe(prisma.activityEvent.count({ where: { kind: { in: ALL_LOGIN_KINDS }, createdAt: { gte: todayStart } } })),
    safe(prisma.activityEvent.count({ where: { kind: { in: LOGIN_FAILED_KINDS }, createdAt: { gte: todayStart } } })),
    safe(prisma.activityEvent.count({ where: { createdAt: { gte: todayStart }, severity: { in: ['warning', 'error', 'critical'] } } })),
    Promise.resolve(0),
    Promise.resolve(0),
    Promise.resolve(0),
    // CAPTCHA is Cloudflare Turnstile (features/captcha/gate.ts). The old
    // Captcha* tables belonged to the removed custom challenge engine and
    // nothing writes them, so these counters were permanently 0. Report the
    // gate's own activity events instead — the data that actually exists.
    captchaGate24h(),
    captchaGate24h('captcha.blocked'),
    captchaGate24h('captcha.attempt_failed'),
    safe(prisma.activityEvent.count({ where: { kind: { startsWith: 'auth.' }, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })),
    Promise.resolve(0),
    Promise.resolve(0),
    Promise.resolve(0),
    Promise.resolve(0),
    safe(prisma.pushSubscription.count()),
  ]);

  /* ─────────────── Group-by breakdowns ─────────────── */
  const [
    adminsByRole, oauth, sessionsByStatus, notificationsByType,
    securityBySeverity, securityTopTypes, auditBySeverity, auditToday, loginByMethod,
    emailByStatus, emailTopTemplates, ticketByStatus, ticketByPriority, ticketByCategory,
    ticketMessages, ticketAttachments, formByStatus, submissionByStatus, formFields, formConnections,
    formAnalyticAgg, mediaByMime, incidentBySeverity, incidentBySource,
  ] = await Promise.all([
    safeMany(prisma.user.groupBy({ by: ['isAdmin'], where: { isAdmin: true }, _count: { isAdmin: true } })),
    Promise.all([
      safe(oauthConnected('google')),
      safe(oauthConnected('github')),
      safe(oauthConnected('discord')),
    ]),
    safeMany(prisma.userSession.groupBy({ by: ['status'], _count: { status: true } })),
    safeMany(prisma.notification.groupBy({ by: ['type'], _count: { type: true } })),
    safeMany(prisma.activityEvent.groupBy({ by: ['severity'], _count: { severity: true } })),
    safeMany(prisma.activityEvent.groupBy({ by: ['kind'], orderBy: { _count: { kind: 'desc' } }, take: 8, _count: { kind: true } })),
    safeMany(prisma.activityEvent.groupBy({ by: ['severity'], _count: { severity: true } })),
    safe(prisma.activityEvent.count({ where: { createdAt: { gte: todayStart } } })),
    safeMany(prisma.activityEvent.groupBy({ by: ['kind'], where: { kind: { in: ALL_LOGIN_KINDS } }, orderBy: { _count: { kind: 'desc' } }, take: 8, _count: { kind: true } })),
    safeMany(prisma.email_deliveries.groupBy({ by: ['status'], _count: { status: true } })),
    safeMany(prisma.email_deliveries.groupBy({ by: ['eventKey'], orderBy: { _count: { eventKey: 'desc' } }, take: 8, _count: { eventKey: true } })),
    Promise.resolve([] as any[]),
    Promise.resolve([] as any[]),
    Promise.resolve([] as any[]),
    Promise.resolve(0),
    Promise.resolve(0),
    Promise.resolve([] as any[]),
    Promise.resolve([] as any[]),
    Promise.resolve(0),
    Promise.resolve(0),
    Promise.resolve({} as any),
    Promise.resolve([] as any[]),
    Promise.resolve([] as any[]),
    Promise.resolve([] as any[]),
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
    safeMany(prisma.activityEvent.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    safeMany(prisma.email_deliveries.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    safeMany(prisma.activityEvent.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart }, kind: { in: ALL_LOGIN_KINDS } }, _count: { createdAt: true } })),
    safeMany(prisma.user.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    safeMany(prisma.activityEvent.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    Promise.resolve([] as any[]),
    safeMany(prisma.notification.groupBy({ by: ['createdAt'], where: { createdAt: { gte: seriesStart } }, _count: { createdAt: true } })),
    Promise.resolve([] as any[]),
    Promise.resolve([] as any[]),
    Promise.resolve([] as any[]),
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
    safeMany(prisma.activityEvent.groupBy({ by: ['kind'], where: { createdAt: { gte: monthAgo } }, _count: { kind: true }, orderBy: { _count: { kind: 'desc' } }, take: 10 })),
    safeMany(prisma.activityEvent.findMany({ where: { createdAt: { gte: weekAgo } }, orderBy: { createdAt: 'desc' }, take: 20, include: { user: { select: { id: true, email: true, profile: { select: { name: true } } } } } })),
    safeMany(prisma.email_deliveries.findMany({ orderBy: { createdAt: 'desc' }, take: 15, select: { id: true, toEmail: true, subject: true, eventKey: true, status: true, openedAt: true, clickedAt: true, createdAt: true } })),
    safeMany(prisma.activityEvent.findMany({ where: { kind: { in: ALL_LOGIN_KINDS } }, orderBy: { createdAt: 'desc' }, take: 15, select: { id: true, kind: true, ipAddress: true, userId: true, createdAt: true } }).then((rows) => rows.map((r) => ({ ...r, eventType: r.kind })))),
    safeMany(prisma.activityEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 15, select: { id: true, kind: true, severity: true, ipAddress: true, userId: true, createdAt: true } }).then((rows) => rows.map((r) => ({ ...r, eventType: r.kind })))),
    Promise.resolve([] as any[]),
    safeMany(prisma.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, type: true, title: true, isRead: true, createdAt: true } })),
    Promise.resolve([] as any[]),
    Promise.resolve([] as any[]),
    // captchaBlock belongs to the removed custom challenge engine — it is never
    // written, so this list was permanently empty. Surface the gate's own
    // activity events instead.
    safeMany(prisma.activityEvent.findMany({
      where: { kind: { in: ['captcha.blocked', 'captcha.attempt_failed'] } },
      orderBy: { createdAt: 'desc' }, take: 8,
      select: { id: true, ipAddress: true, kind: true, title: true, detail: true, createdAt: true },
    }).then((rows) => rows.map((r) => ({
      id: r.id,
      ipAddress: r.ipAddress,
      reason: r.detail ?? r.title,
      difficulty: r.kind === 'captcha.blocked' ? 1 : 0,
      blockedAt: r.createdAt.toISOString(),
      unblockedAt: null as string | null,
    })))),
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

  const [revokedKeys, expiredKeys] = [0, 0];

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
      requests: { hits: rateLimits.totalHits, blocked: rateLimits.totalBlocked, bypassed: rateLimits.totalBypassed, blockRate: rateLimits.blockRate, trackedQueries: queryPerfRaw.totalTrackedQueries } },
    tables,
    users: {
      total: tables.user, active: activeUsers, activeToday: activeUsersToday, newToday, newThisWeek, newThisMonth,
      verifiedEmail, verifiedPhone, banned, suspended, scheduledDeletion, deleted, twoFA, mustChange,
      admins: adminsByRole.map((r: any) => ({ role: 'admin', count: r._count?.isAdmin ?? 0 })),
      oauth: { google: oauth[0], github: oauth[1], discord: oauth[2] } },
    sessions: { total: tables.session, active: activeSessions, byStatus: sessionsByStatus.map((s: any) => ({ status: s.status || 'unknown', count: s._count.status ?? 0 })) },
    apiKeys: { total: tables.apiKey, active: activeApiKeys, revoked: revokedKeys, expired: expiredKeys },
    notifications: {
      total: totalNotifications, unread: unreadNotifications,
      byType: notificationsByType.map((n: any) => ({ type: n.type || 'other', count: n._count.type ?? 0 })) },
    security: {
      total: tables.securityEvent, today: securityEventsToday,
      bySeverity: securityBySeverity.map((s: any) => ({ severity: s.severity ?? 'info', count: s._count.severity ?? 0 })),
      topTypes: securityTopTypes.map((s: any) => ({ eventType: s.kind || 'unknown', count: s._count.kind ?? 0 })) },
    auditInfo: { total30d: tables.auditEvent, today: auditToday, bySeverity: auditBySeverity.map((s: any) => ({ severity: s.severity ?? 'info', count: s._count.severity ?? 0 })) },
    logins: {
      total: tables.loginHistory, today: loginsToday, successToday: loginsSuccessToday, failedToday: failedLoginsToday,
      successRateToday: loginsToday ? Math.round((loginsSuccessToday / loginsToday) * 100) : 100,
      byMethod: loginByMethod.map((l: any) => ({ method: l.kind || 'unknown', count: l._count.kind ?? 0 })) },
    emails: {
      total: tables.emailLog, today: emailsToday, lastHour: emailsLastHour, failures: emailFailures,
      opened: emailsOpened, clicked: emailsClicked,
      openRate: tables.emailLog ? Math.round((emailsOpened / tables.emailLog) * 100) : 0,
      clickRate: tables.emailLog ? Math.round((emailsClicked / tables.emailLog) * 100) : 0,
      topTemplates: emailTopTemplates.map((e: any) => ({ template: e.template || 'unknown', count: e._count.template ?? 0 })),
      byStatus: emailByStatus.map((e: any) => ({ status: e.status || 'unknown', count: e._count.status ?? 0 })) },
    tickets: {
      total: totalTickets, open: openTickets,
      closed: (ticketByStatus.find((t: any) => t.status === 'closed')?._count.status) ?? 0,
      resolved: (ticketByStatus.find((t: any) => t.status === 'resolved')?._count.status) ?? 0,
      byStatus: ticketByStatus.map((t: any) => ({ status: t.status || 'open', count: t._count.status ?? 0 })),
      byPriority: ticketByPriority.map((t: any) => ({ priority: t.priority || 'normal', count: t._count.priority ?? 0 })),
      byCategory: ticketByCategory.map((t: any) => ({ category: t.category || 'general', count: t._count.category ?? 0 })),
      messages: ticketMessages, attachments: ticketAttachments },
    forms: {
      total: tables.form, submissions: totalSubmissions, submissionsToday, fields: formFields, connections: formConnections,
      views: formAnalyticAgg?._sum?.views ?? 0, starts: formAnalyticAgg?._sum?.starts ?? 0,
      byStatus: formByStatus.map((f: any) => ({ status: f.status || 'draft', count: f._count.status ?? 0 })),
      submissionByStatus: submissionByStatus.map((s: any) => ({ status: s.status || 'new', count: s._count.status ?? 0 })) },
    media: {
      total: tables.media, today: mediaToday,
      byMime: mediaByMime.map((m: any) => ({ mimeType: m.mimeType || 'other', count: m._count.mimeType ?? 0 })) },
    captcha: {
      provider: 'turnstile',
      // Configuration is what actually breaks in practice (a missing key locks
      // every login out), so surface it instead of a dead table count.
      configured: isTurnstileConfigured(),
      siteKeyPresent: Boolean(getTurnstileSiteKey()),
      secretPresent: Boolean(process.env.TURNSTILE_SECRET_KEY),
      challenges: captchaChallenges, solved: captchaSolved, solvedRate: captchaChallenges ? Math.round((captchaSolved / captchaChallenges) * 100) : 100,
      attempts: captchaAttempts, blocks: captchaBlocks, activeBlocks: captchaActiveBlocks, logs: captchaLogs },
    incidents: {
      total: incidentCount, today: incidentToday,
      bySeverity: incidentBySeverity.map((i: any) => ({ severity: i.severity ?? 'error', count: i._count.severity ?? 0 })),
      bySource: incidentBySource.map((i: any) => ({ source: i.source ?? 'client', count: i._count.source ?? 0 })) },
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
      media: bucketOf(mediaByDay) },
    topActions: topActions.map((a: any) => ({ action: a.kind, count: a._count.kind })),
    emailStatusBreakdown: emailByStatus,
    recentAudit: recentAudit.map((l: any) => ({ ...l, actor: l.user ? { ...l.user, name: l.user.profile?.name ?? null } : l.user })),
    recentEmails,
    recentLogins,
    recentSecurity,
    recentTickets,
    recentNotifications,
    recentSubmissions,
    recentIncidents,
    recentCaptcha };

  g.__adminDashCache[days] = { data: body, ts: Date.now() };
  return NextResponse.json(body);
}