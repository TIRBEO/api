import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { jsonUnauthorized, jsonForbidden, jsonError, jsonTooManyRequests } from './response';

// ─── Incident events (crash / error receiver) ─────────────────────
// Single consolidated table. Client crash reports are accepted from
// authenticated users when they consented to crash reporting.

const MAX_EVENTS_PER_HOUR = 60;

export async function incidentEventsListHandler(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return jsonUnauthorized();
  const url = new URL(req.url);
  const take = Math.min(parseInt(url.searchParams.get('take') || '50', 10) || 50, 200);
  const events = await prisma.incident_events.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      source: true,
      type: true,
      severity: true,
      message: true,
      stack: true,
      url: true,
      userId: true,
      metadata: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ events });
}

export async function incidentEventsCreateHandler(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return jsonUnauthorized();

  // Consent gate: crash reports only leave the browser if the user opted in.
  let consents: any = null;
  try {
    const row = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { consents: true },
    });
    consents = (row as any)?.consents ?? null;
  } catch {}
  if (!consents?.allowCrashReports) {
    return jsonError('CRASH_REPORTS_DISABLED', 403);
  }

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

  return NextResponse.json({ event }, { status: 201 });
}
