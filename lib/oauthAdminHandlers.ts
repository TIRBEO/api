import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { prisma } from './db/prisma';
import { requireAdmin } from './session';
import { jsonError } from './response';
import { createAuditEvent } from './audit';
import { sanitizeInput } from './security';

/**
 * Admin management for the "Login with Tirbeo" OAuth registry.
 *
 *   GET    /api/admin/oauth/apps                → apps + clients (secrets redacted)
 *   POST   /api/admin/oauth/apps                → create app
 *   PATCH  /api/admin/oauth/apps/[id]           → update app
 *   DELETE /api/admin/oauth/apps/[id]           → delete app (cascades clients)
 *   POST   /api/admin/oauth/clients             → create client (clientId + secret shown once)
 *   PATCH  /api/admin/oauth/clients/[id]        → update client (redirectUris/scopes/grants/isActive)
 *   POST   /api/admin/oauth/clients/[id]/secret → regenerate secret (shown once)
 *   DELETE /api/admin/oauth/clients/[id]        → delete client
 *
 * Client secrets are stored plaintext (matching the token endpoint's comparison)
 * but are NEVER returned by list/update endpoints — only on create/regenerate.
 */

const SCOPE_RE = /^[a-z][a-z0-9_.:-]*$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED_GRANTS = new Set(['authorization_code', 'refresh_token', 'client_credentials']);

function normalizeGrants(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return fallback;
  const grants = raw.map(String).filter((g) => ALLOWED_GRANTS.has(g));
  return grants.length > 0 ? Array.from(new Set(grants)) : fallback;
}

function isValidRedirectUri(u: string): boolean {
  try {
    const parsed = new URL(u);
    if (parsed.protocol === 'https:') return true;
    // Localhost is allowed for local development.
    if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) return true;
    return false;
  } catch {
    return false;
  }
}

/** Public client shape — never includes clientSecret. */
function pickClient(c: {
  id: string;
  clientId: string;
  redirectUris: unknown;
  scopes: unknown;
  grants: unknown;
  isActive: boolean;
  createdAt: Date;
  clientSecret?: string | null;
}) {
  return {
    id: c.id,
    clientId: c.clientId,
    redirectUris: (c.redirectUris as string[]) || [],
    scopes: (c.scopes as string[]) || [],
    grants: (c.grants as string[]) || [],
    isActive: c.isActive,
    createdAt: c.createdAt,
    hasSecret: !!c.clientSecret,
  };
}

export async function oauthAdminAppsListHandler(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;
  const apps = await prisma.apps.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      owner: { select: { id: true, name: true, email: true } },
      oauthClients: { orderBy: { createdAt: 'desc' } },
    },
  });
  return NextResponse.json({
    apps: apps.map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      description: a.description,
      url: a.url,
      icon: a.icon,
      isPublic: a.isPublic,
      status: a.status,
      createdAt: a.createdAt,
      owner: a.owner,
      clients: a.oauthClients.map(pickClient),
    })),
  });
}

export async function oauthAdminAppsCreateHandler(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;
  const body: any = await request.json().catch(() => ({}));
  const name = sanitizeInput(String(body.name || ''), 200).trim();
  const slug = sanitizeInput(String(body.slug || ''), 200).trim().toLowerCase();
  if (!name || !slug || !SLUG_RE.test(slug)) {
    return jsonError('A name and a valid slug (lowercase letters, numbers, hyphens) are required', 400);
  }
  const existing = await prisma.apps.findUnique({ where: { slug } });
  if (existing) return jsonError('An app with this slug already exists', 409);

  const app = await prisma.apps.create({
    data: {
      name,
      slug,
      description: body.description ? sanitizeInput(String(body.description), 2000) : undefined,
      url: body.url ? sanitizeInput(String(body.url), 500) : undefined,
      icon: body.icon ? sanitizeInput(String(body.icon), 500) : undefined,
      isPublic: body.isPublic !== false,
      ownerId: admin.userId,
    },
  });
  await createAuditEvent({ actorId: admin.userId, action: 'APPLICATION_CREATED', targetType: 'app', targetId: app.id });
  return NextResponse.json({ app }, { status: 201 });
}

export async function oauthAdminAppsUpdateHandler(request: NextRequest, appId: string) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;
  const body: any = await request.json().catch(() => ({}));
  const app = await prisma.apps.findUnique({ where: { id: appId } });
  if (!app) return jsonError('App not found', 404);

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = sanitizeInput(String(body.name), 200).trim();
    if (!name) return jsonError('Name cannot be empty', 400);
    data.name = name;
  }
  if (body.slug !== undefined) {
    const slug = sanitizeInput(String(body.slug), 200).trim().toLowerCase();
    if (!SLUG_RE.test(slug)) return jsonError('Invalid slug (lowercase letters, numbers, hyphens)', 400);
    const clash = await prisma.apps.findFirst({ where: { slug, id: { not: appId } } });
    if (clash) return jsonError('An app with this slug already exists', 409);
    data.slug = slug;
  }
  if (body.description !== undefined) data.description = body.description ? sanitizeInput(String(body.description), 2000) : null;
  if (body.url !== undefined) data.url = body.url ? sanitizeInput(String(body.url), 500) : null;
  if (body.icon !== undefined) data.icon = body.icon ? sanitizeInput(String(body.icon), 500) : null;
  if (body.isPublic !== undefined) data.isPublic = !!body.isPublic;

  const updated = await prisma.apps.update({ where: { id: appId }, data });
  await createAuditEvent({ actorId: admin.userId, action: 'APPLICATION_UPDATED', targetType: 'app', targetId: appId });
  return NextResponse.json({ app: updated });
}

export async function oauthAdminAppsDeleteHandler(request: NextRequest, appId: string) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;
  const app = await prisma.apps.findUnique({ where: { id: appId } });
  if (!app) return jsonError('App not found', 404);
  await prisma.apps.delete({ where: { id: appId } });
  await createAuditEvent({ actorId: admin.userId, action: 'APPLICATION_DELETED', targetType: 'app', targetId: appId });
  return NextResponse.json({ deleted: true });
}

export async function oauthAdminClientsCreateHandler(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;
  const body: any = await request.json().catch(() => ({}));
  const appId = String(body.appId || '');
  const app = await prisma.apps.findUnique({ where: { id: appId } });
  if (!app) return jsonError('App not found', 404);

  const redirectUris = (Array.isArray(body.redirectUris) ? body.redirectUris.map(String) : []).filter(Boolean);
  const scopes = (Array.isArray(body.scopes) ? body.scopes.map(String) : []).filter(Boolean);
  if (redirectUris.length === 0 || !redirectUris.every(isValidRedirectUri)) {
    return jsonError('At least one valid HTTPS redirect URI is required', 400);
  }
  if (scopes.length === 0 || !scopes.every((s) => SCOPE_RE.test(s))) {
    return jsonError('At least one valid scope is required (lowercase letters, numbers, . _ : -)', 400);
  }
  const grants = normalizeGrants(body.grants, ['authorization_code', 'refresh_token']);

  const clientId = `tirbeo_${Buffer.from(randomBytes(16)).toString('hex')}`;
  const clientSecret = `tbsec_${Buffer.from(randomBytes(32)).toString('hex')}`;
  const client = await prisma.app_oauth_clients.create({
    data: {
      appId,
      clientId,
      clientSecret,
      redirectUris,
      scopes,
      grants,
      isActive: true,
      updatedAt: new Date(),
    },
  });
  await createAuditEvent({ actorId: admin.userId, action: 'OAUTH_CLIENT_CREATED', targetType: 'oauth_client', targetId: client.id });
  return NextResponse.json({ client: pickClient(client), clientSecret }, { status: 201 });
}

export async function oauthAdminClientsUpdateHandler(request: NextRequest, clientRowId: string) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;
  const body: any = await request.json().catch(() => ({}));
  const client = await prisma.app_oauth_clients.findUnique({ where: { id: clientRowId } });
  if (!client) return jsonError('Client not found', 404);

  const data: Record<string, unknown> = {};
  if (body.redirectUris !== undefined) {
    const redirectUris = (Array.isArray(body.redirectUris) ? body.redirectUris.map(String) : []).filter(Boolean);
    if (redirectUris.length === 0 || !redirectUris.every(isValidRedirectUri)) {
      return jsonError('At least one valid HTTPS redirect URI is required', 400);
    }
    data.redirectUris = redirectUris;
  }
  if (body.scopes !== undefined) {
    const scopes = (Array.isArray(body.scopes) ? body.scopes.map(String) : []).filter(Boolean);
    if (scopes.length === 0 || !scopes.every((s) => SCOPE_RE.test(s))) {
      return jsonError('At least one valid scope is required', 400);
    }
    data.scopes = scopes;
  }
  if (body.grants !== undefined) data.grants = normalizeGrants(body.grants, client.grants as string[]);
  if (body.isActive !== undefined) data.isActive = !!body.isActive;
  data.updatedAt = new Date();

  const updated = await prisma.app_oauth_clients.update({ where: { id: clientRowId }, data });
  await createAuditEvent({ actorId: admin.userId, action: 'OAUTH_CLIENT_UPDATED', targetType: 'oauth_client', targetId: clientRowId });
  return NextResponse.json({ client: pickClient(updated) });
}

export async function oauthAdminClientsRegenerateSecretHandler(request: NextRequest, clientRowId: string) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;
  const client = await prisma.app_oauth_clients.findUnique({ where: { id: clientRowId } });
  if (!client) return jsonError('Client not found', 404);
  const clientSecret = `tbsec_${Buffer.from(randomBytes(32)).toString('hex')}`;
  await prisma.app_oauth_clients.update({ where: { id: clientRowId }, data: { clientSecret, updatedAt: new Date() } });
  await createAuditEvent({ actorId: admin.userId, action: 'OAUTH_CLIENT_SECRET_REGENERATED', targetType: 'oauth_client', targetId: clientRowId });
  return NextResponse.json({ clientId: client.clientId, clientSecret });
}

export async function oauthAdminClientsDeleteHandler(request: NextRequest, clientRowId: string) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;
  const client = await prisma.app_oauth_clients.findUnique({ where: { id: clientRowId } });
  if (!client) return jsonError('Client not found', 404);
  await prisma.app_oauth_clients.delete({ where: { id: clientRowId } });
  await createAuditEvent({ actorId: admin.userId, action: 'OAUTH_CLIENT_DELETED', targetType: 'oauth_client', targetId: clientRowId });
  return NextResponse.json({ deleted: true });
}
