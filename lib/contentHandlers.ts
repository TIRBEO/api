import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession, requireAdmin } from './session';
import { jsonUnauthorized, jsonForbidden, jsonError, jsonTooManyRequests } from './response';
import { hasConsent } from './consent';

// ─── Incident events (crash / error receiver) ─────────────────────
// Single consolidated table. Client crash reports are accepted from
// authenticated users when they consented to crash reporting.
// Every crash is forwarded to all admins via email.

const MAX_EVENTS_PER_HOUR = 60;

export async function incidentEventsListHandler(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const url = new URL(req.url);
  const take = Math.min(parseInt(url.searchParams.get('take') || '50', 10) || 50, 200);
  const skip = parseInt(url.searchParams.get('skip') || '0', 10) || 0;
  const userId = url.searchParams.get('userId') || undefined;
  const severity = url.searchParams.get('severity') || undefined;

  const where: any = {};
  if (userId) where.userId = userId;
  if (severity) where.severity = severity;

  const [events, total] = await Promise.all([
    prisma.incident_events.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      select: {
        id: true,
        source: true,
        type: true,
        severity: true,
        message: true,
        stack: true,
        url: true,
        userId: true,
        userAgent: true,
        metadata: true,
        createdAt: true,
      },
    }),
    prisma.incident_events.count({ where }),
  ]);

  // Enrich with user email
  const userIds = [...new Set(events.map((e) => e.userId).filter(Boolean))] as string[];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, username: true } })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  const enriched = events.map((e) => {
    const u = e.userId ? userMap.get(e.userId) : null;
    return { ...e, userEmail: u?.email ?? null, username: u?.username ?? null };
  });

  return NextResponse.json({ events: enriched, total });
}

export async function incidentEventsCreateHandler(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return jsonUnauthorized();

  // Consent gate: crash reports only leave the browser if the user opted in.
  const crashAllowed = await hasConsent(session.userId, 'crashReports');
  if (!crashAllowed) {
    return jsonError('CRASH_REPORTS_DISABLED', 403);
  }

  // Fetch user info for admin notification
  let user: any = null;
  try {
    user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { email: true, username: true },
    });
  } catch {}

  // Light abuse guard
  const recent = await prisma.incident_events.count({
    where: { userId: session.userId, createdAt: { gte: new Date(Date.now() - 3600_000) } },
  });
  if (recent >= MAX_EVENTS_PER_HOUR) return jsonTooManyRequests('Too many crash reports');

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonError('INVALID_BODY', 400);
  }
  const type = typeof body?.type === 'string' ? body.type.slice(0, 120) : '';
  if (!type) return jsonError('TYPE_REQUIRED', 400);

  const message = typeof body?.message === 'string' ? body.message.slice(0, 4000) : null;
  const stack = typeof body?.stack === 'string' ? body.stack.slice(0, 8000) : null;
  const rawUrl = typeof body?.url === 'string' ? body.url.slice(0, 1000) : null;
  const allowedSeverities = new Set(['info', 'warning', 'error', 'critical']);
  const severity = allowedSeverities.has(body?.severity) ? body.severity : 'error';
  const metadata =
    body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata
      : {};

  const event = await prisma.incident_events.create({
    data: {
      source: typeof body?.source === 'string' ? body.source.slice(0, 40) : 'client',
      type,
      severity,
      message,
      stack,
      url: rawUrl,
      userAgent: req.headers.get('user-agent')?.slice(0, 500) || null,
      userId: session.userId,
      metadata,
    },
    select: { id: true, type: true, severity: true, createdAt: true },
  });

  // Notify admins via email (async, non-blocking)
  notifyAdminsOfCrash(event, {
    userId: session.userId,
    userEmail: user?.email ?? 'unknown',
    username: user?.username ?? 'unknown',
    url: rawUrl,
    message,
    stack,
    severity,
    source: typeof body?.source === 'string' ? body.source.slice(0, 40) : 'client',
    userAgent: req.headers.get('user-agent')?.slice(0, 200) || null,
  }).catch(() => {});

  return NextResponse.json({ event }, { status: 201 });
}

// ─── Notify all admins of a crash report ──────────────────────────
async function notifyAdminsOfCrash(event: any, data: {
  userId: string; userEmail: string; username: string;
  url: string | null; message: string | null; stack: string | null;
  severity: string; source: string; userAgent: string | null;
}) {
  try {
    const { sendTemplateEmail } = await import('./email');
    const admins = await prisma.user.findMany({ where: { adminRole: { not: null } }, select: { email: true } });
    if (!admins.length) return;

    const sevColor: Record<string, string> = { info: '#3b82f6', warning: '#f59e0b', error: '#ef4444', critical: '#7c3aed' };
    const color = sevColor[data.severity] || '#ef4444';
    const adminBase = process.env.ADMIN_URL || 'https://admin.tirbeo.app';

    for (const admin of admins) {
      await sendTemplateEmail(
        admin.email,
        'admin_crash_report',
        {
          severity: data.severity.toUpperCase(),
          errorType: data.severity.toUpperCase(),
          message: data.message || 'No message',
          userEmail: data.userEmail,
          username: data.username,
          url: data.url || 'N/A',
          source: data.source,
          stack: data.stack || 'No stack trace',
          userAgent: data.userAgent || 'N/A',
          eventId: event.id,
          timestamp: event.createdAt?.toISOString?.() || new Date().toISOString(),
          dashboardUrl: `${adminBase}/admin/operations/crashes`,
        }
      );
    }
  } catch {}
}
