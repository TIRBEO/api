import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { jsonError, jsonForbidden, jsonUnauthorized } from './response';
import { createAuditEvent } from './audit';
import { sanitizeInput } from './security';

function isAdmin(user: any): boolean {
  return user?.adminRole != null && ['super_admin', 'admin'].includes(user.adminRole);
}

// Blog CRUD
export async function blogListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');
  const where: any = {};
  if (status) where.status = status;
  if (!isAdmin(user)) where.authorId = user.userId;
  const [data, total] = await Promise.all([
    prisma.blog.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' }, include: { author: { select: { id: true, name: true, photoUrl: true } }, category: true } }),
    prisma.blog.count({ where }),
  ]);
  return NextResponse.json({ data, total, page, limit });
}

export async function blogCreateHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const body = await req.json();
  const blog = await prisma.blog.create({ data: { title: sanitizeInput(String(body.title || ''), 500), slug: sanitizeInput(String(body.slug || ''), 200), content: body.content ? sanitizeInput(String(body.content), 500000) : undefined, categoryId: body.categoryId, status: body.status, authorId: user.userId } });
  await createAuditEvent({ actorId: user.userId, action: 'BLOG_CREATED', targetType: 'blog', targetId: blog.id, metadata: { title: blog.title } });
  return NextResponse.json(blog, { status: 201 });
}

export async function blogDetailHandler(req: NextRequest, blogId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const blog = await prisma.blog.findUnique({ where: { id: blogId }, include: { author: true, category: true, tags: true, versions: { orderBy: { version: 'desc' }, take: 1 } } });
  if (!blog) return jsonError('NOT_FOUND', 'Blog not found', 404);
  return NextResponse.json(blog);
}

export async function blogUpdateHandler(req: NextRequest, blogId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const body = await req.json();
  const blog = await prisma.blog.findUnique({ where: { id: blogId } });
  if (!blog) return jsonError('NOT_FOUND', 'Blog not found', 404);
  if (blog.authorId !== user.userId && !isAdmin(user)) return jsonForbidden();
  const updated = await prisma.blog.update({ where: { id: blogId }, data: { title: sanitizeInput(String(body.title || ''), 500), content: body.content ? sanitizeInput(String(body.content), 500000) : undefined, categoryId: body.categoryId, status: body.status } });
  await createAuditEvent({ actorId: user.userId, action: 'BLOG_UPDATED', targetType: 'blog', targetId: blogId });
  return NextResponse.json(updated);
}

export async function blogDeleteHandler(req: NextRequest, blogId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const blog = await prisma.blog.findUnique({ where: { id: blogId } });
  if (!blog) return jsonError('NOT_FOUND', 'Blog not found', 404);
  if (blog.authorId !== user.userId && !isAdmin(user)) return jsonForbidden();
  await prisma.blog.delete({ where: { id: blogId } });
  await createAuditEvent({ actorId: user.userId, action: 'BLOG_DELETED', targetType: 'blog', targetId: blogId });
  return NextResponse.json({ message: 'Blog deleted' });
}

export async function blogPublishHandler(req: NextRequest, blogId: string) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const blog = await prisma.blog.update({ where: { id: blogId }, data: { status: 'published', publishedAt: new Date() } });
  await prisma.blog_versions.create({ data: { blogId, title: blog.title, content: blog.content, version: (await prisma.blog_versions.count({ where: { blogId } })) + 1, createdBy: user.userId } });
  await createAuditEvent({ actorId: user.userId, action: 'BLOG_PUBLISHED', targetType: 'blog', targetId: blogId });
  return NextResponse.json(blog);
}

// Pages CRUD
export async function pageListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const pages = await prisma.page.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json(pages);
}

export async function pageCreateHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const body = await req.json();
  const page = await prisma.page.create({ data: { title: sanitizeInput(String(body.title || ''), 500), slug: sanitizeInput(String(body.slug || ''), 200), content: body.content ? sanitizeInput(String(body.content), 500000) : undefined, components: body.components, status: body.status } });
  await createAuditEvent({ actorId: user.userId, action: 'PAGE_CREATED', targetType: 'page', targetId: page.id });
  return NextResponse.json(page, { status: 201 });
}

export async function pageDetailHandler(req: NextRequest, pageId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const page = await prisma.page.findUnique({ where: { id: pageId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
  if (!page) return jsonError('NOT_FOUND', 'Page not found', 404);
  return NextResponse.json(page);
}

export async function pageUpdateHandler(req: NextRequest, pageId: string) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const body = await req.json();
  const page = await prisma.page.update({ where: { id: pageId }, data: { title: sanitizeInput(String(body.title || ''), 500), slug: sanitizeInput(String(body.slug || ''), 200), content: body.content ? sanitizeInput(String(body.content), 500000) : undefined, components: body.components, status: body.status } });
  await createAuditEvent({ actorId: user.userId, action: 'PAGE_UPDATED', targetType: 'page', targetId: pageId });
  return NextResponse.json(page);
}

export async function pagePublishHandler(req: NextRequest, pageId: string) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const page = await prisma.page.findUnique({ where: { id: pageId } });
  if (!page) return jsonError('NOT_FOUND', 'Page not found', 404);
  await prisma.page_versions.create({ data: { pageId, title: page.title, content: page.content, components: page.components, version: (await prisma.page_versions.count({ where: { pageId } })) + 1, createdBy: user.userId } });
  const updated = await prisma.page.update({ where: { id: pageId }, data: { status: 'published', publishedAt: new Date() } });
  await createAuditEvent({ actorId: user.userId, action: 'PAGE_PUBLISHED', targetType: 'page', targetId: pageId });
  return NextResponse.json(updated);
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
  const body = await req.json();
  const { key, value } = body;
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
  await createAuditEvent({ actorId: user.userId, action: 'SETTING_CHANGED', targetType: 'setting', targetId: key, metadata: { key } });
  return NextResponse.json({ message: 'Setting updated' });
}

// Feature Flags
export async function featureFlagsListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const flags = await prisma.featureFlag.findMany({ include: { targets: true } });
  return NextResponse.json(flags);
}

export async function featureFlagsUpdateHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const body = await req.json();
  const { id, enabled } = body;
  await prisma.featureFlag.update({ where: { id }, data: { isActive: enabled } });
  await createAuditEvent({ actorId: user.userId, action: 'FEATURE_FLAG_CHANGED', targetType: 'feature_flag', targetId: id });
  return NextResponse.json({ message: 'Feature flag updated' });
}

// Plans
export async function plansListHandler(req: NextRequest) {
  const plans = await prisma.plans.findMany({ where: { isPublic: true }, orderBy: { sortOrder: 'asc' } });
  return NextResponse.json(plans);
}

export async function plansAdminListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const plans = await prisma.plans.findMany({ orderBy: { sortOrder: 'asc' } });
  return NextResponse.json(plans);
}

export async function plansCreateHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const body = await req.json();
  const plan = await prisma.plans.create({ data: { name: sanitizeInput(String(body.name || ''), 200), slug: sanitizeInput(String(body.slug || ''), 200), price: body.price, interval: body.interval, features: body.features } });
  await createAuditEvent({ actorId: user.userId, action: 'PLAN_CREATED', targetType: 'plan', targetId: plan.id });
  return NextResponse.json(plan, { status: 201 });
}

// Apps (Registry)
export async function appsListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const apps = await prisma.apps.findMany({ where: { isPublic: true }, include: { owner: { select: { id: true, name: true } } } });
  return NextResponse.json(apps);
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
  const body = await req.json();
  const app = await prisma.apps.create({ data: { name: sanitizeInput(String(body.name || ''), 200), slug: sanitizeInput(String(body.slug || ''), 200), description: body.description ? sanitizeInput(String(body.description), 2000) : undefined, icon: body.icon, url: body.url, isPublic: body.isPublic, ownerId: user.userId } });
  await createAuditEvent({ actorId: user.userId, action: 'APPLICATION_CREATED', targetType: 'app', targetId: app.id });
  return NextResponse.json(app, { status: 201 });
}

// System Health
export async function systemHealthHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const services = await prisma.system_services.findMany();
  return NextResponse.json({ services });
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
  const body = await req.json();
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
