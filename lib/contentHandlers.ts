import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { jsonError, jsonForbidden, jsonUnauthorized } from './response';
import { createAuditEvent } from './audit';
import { sanitizeInput } from './security';

function isAdmin(user: any): boolean {
  return user?.adminRole != null && ['super_admin', 'admin'].includes(user.adminRole);
}

// Settings
export async function settingsListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const settings = await prisma.setting.findMany({ orderBy: { group: 'asc' } });
  return NextResponse.json(settings);
}

export async function settingsUpdateHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const body: any = await req.json();
  const { key, value } = body;
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
  await createAuditEvent({ actorId: user.userId, action: 'SETTING_CHANGED', targetType: 'setting', targetId: key, metadata: { key } });
  return NextResponse.json({ message: 'Setting updated' });
}

// Feature Flags
export async function featureFlagsListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const flags = await prisma.featureFlag.findMany();
  return NextResponse.json(flags);
}

export async function featureFlagsUpdateHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const body: any = await req.json();
  const { id, enabled } = body;
  await prisma.featureFlag.update({ where: { id }, data: { isActive: enabled } });
  await createAuditEvent({ actorId: user.userId, action: 'FEATURE_FLAG_CHANGED', targetType: 'feature_flag', targetId: id });
  return NextResponse.json({ message: 'Feature flag updated' });
}

// Apps (Registry)
export async function appsListHandler(req: NextRequest) {
  try {
    const user = await getSession(req);
    if (!user) return jsonUnauthorized();
    const apps = await prisma.apps.findMany({ where: { isPublic: true }, include: { owner: { select: { id: true, name: true } } } });
    return NextResponse.json(apps);
  } catch (err: any) {
    console.error('[APPS LIST]', err?.message || err);
    return NextResponse.json([]);
  }
}

export async function appsAdminListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const apps = await prisma.apps.findMany({ include: { owner: { select: { id: true, name: true } }, oauthClients: true } });
  return NextResponse.json(apps);
}

export async function appsCreateHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const body: any = await req.json();
  const app = await prisma.apps.create({ data: { name: sanitizeInput(String(body.name || ''), 200), slug: sanitizeInput(String(body.slug || ''), 200), description: body.description ? sanitizeInput(String(body.description), 2000) : undefined, icon: body.icon, url: body.url, isPublic: body.isPublic, ownerId: user.userId } });
  await createAuditEvent({ actorId: user.userId, action: 'APPLICATION_CREATED', targetType: 'app', targetId: app.id });
  return NextResponse.json(app, { status: 201 });
}



// Incidents
export async function incidentsListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const incidents = await prisma.incidents.findMany({ orderBy: { createdAt: 'desc' }, include: { events: true } });
  return NextResponse.json(incidents);
}

export async function incidentsCreateHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const body: any = await req.json();
  const incident = await prisma.incidents.create({ data: { title: sanitizeInput(String(body.title || ''), 500), description: body.description ? sanitizeInput(String(body.description), 20000) : undefined, severity: body.severity, status: body.status, ownerId: user.userId } });
  await createAuditEvent({ actorId: user.userId, action: 'INCIDENT_CREATED', targetType: 'incident', targetId: incident.id });
  return NextResponse.json(incident, { status: 201 });
}

// Jobs
export async function jobsListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const jobs = await prisma.jobs.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  return NextResponse.json(jobs);
}

// ─── GET /api/content/incidents/[id]/events ──────────────────────
export async function incidentEventsListHandler(req: NextRequest, incidentId: string) {
  try {
    const session = await getSession(req);
    if (!session) return jsonUnauthorized();
    const events = await prisma.incident_events.findMany({
      where: { incidentId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        message: true,
        userId: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ events });
  } catch (err: any) {
    console.error('[INCIDENT EVENTS LIST]', err?.message || err);
    return new NextResponse('Failed to fetch incident events', { status: 500 });
  }
}

// ─── POST /api/content/incidents/[id]/events ──────────────────────
export async function incidentEventsCreateHandler(req: NextRequest, incidentId: string) {
  try {
    const session = await getSession(req);
    if (!session) return jsonUnauthorized();
    const body: any = await req.json();
    const { type, message } = body;
    if (!type) return new NextResponse('Event type required', { status: 400 });
    const event = await prisma.incident_events.create({
      data: {
        incidentId,
        type,
        message: message || null,
        userId: session.userId,
      },
      select: {
        id: true,
        type: true,
        message: true,
        userId: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ event }, { status: 201 });
  } catch (err: any) {
    console.error('[INCIDENT EVENTS CREATE]', err?.message || err);
    return new NextResponse('Failed to create incident event', { status: 500 });
  }
}
