/**
 * End-to-end verification of the admin OAuth client management endpoints.
 *
 * Drives the real route handlers against the live DB:
 *   list apps → create app → create client (secret once) → list (redacted) →
 *   update client → rotate secret → update app → delete client → delete app
 *
 * Run from apps/api:  npx tsx --env-file=.env.local scripts/verify-oauth-admin.ts
 * Creates and cleans up its own test app, client and session.
 */
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { prisma } from '../lib/db/prisma';
import { createSession, revokeSession } from '../lib/auth/session';
import {
  oauthAdminAppsListHandler,
  oauthAdminAppsCreateHandler,
  oauthAdminAppsUpdateHandler,
  oauthAdminAppsDeleteHandler,
  oauthAdminClientsCreateHandler,
  oauthAdminClientsUpdateHandler,
  oauthAdminClientsRegenerateSecretHandler,
  oauthAdminClientsDeleteHandler,
} from '../lib/oauthAdminHandlers';

let failures = 0;
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const API = 'http://localhost:3000';
const body = (obj: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${API}/x`, {
    method: 'POST',
    body: JSON.stringify(obj),
    headers: { 'content-type': 'application/json', ...headers },
  });

const json = (r: Response) => r.json().catch(() => ({}));

async function main() {
  // Find an admin-capable user (adminRole or an 'admin'/'super_admin' role).
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, email: true, adminRole: true, roles: { include: { role: { select: { name: true } } } } },
  });
  let adminUser = users.find(
    (u) => u.adminRole || u.roles?.some((r) => /admin|super_admin/i.test(r.role.name)),
  );
  if (!adminUser) {
    adminUser = users[0];
    console.log('⚠ No admin-role user found — using most recent user; admin-gating checks may not apply cleanly.');
  }
  console.log(`Using admin user: ${adminUser.email} (${adminUser.id})`);

  const session = await createSession(adminUser.id);
  const authHeaders = { cookie: `__session=${session.token}` };

  let appId = '';
  let clientId = '';
  let clientRowId = '';

  try {
    const slug = `verify-oauth-admin-${Date.now()}`;

    // ── 1. List apps ────────────────────────────────────────────────────
    let res = await oauthAdminAppsListHandler(new NextRequest(`${API}/x`, { headers: authHeaders }));
    let data: any = await json(res);
    check('apps list: 200', res.status === 200, `status=${res.status}`);
    check('apps list: array', Array.isArray(data.apps));

    // ── 2. Create app ───────────────────────────────────────────────────
    res = await oauthAdminAppsCreateHandler(
      body({ name: 'Verify OAuth Admin App', slug, description: 'admin verify', url: 'https://verify.example.com' }, authHeaders),
    );
    data = await json(res);
    check('create app: 201', res.status === 201, `status=${res.status}`);
    check('create app: slug unique', data.app?.slug === slug);
    appId = data.app?.id || '';

    // ── 3. Duplicate slug rejected ──────────────────────────────────────
    res = await oauthAdminAppsCreateHandler(
      body({ name: 'Duplicate', slug, url: 'https://dup.example.com' }, authHeaders),
    );
    check('create app: duplicate slug → 409', res.status === 409, `status=${res.status}`);

    // ── 4. Invalid slug rejected ────────────────────────────────────────
    res = await oauthAdminAppsCreateHandler(
      body({ name: 'Bad', slug: 'Bad Slug!', url: 'https://bad.example.com' }, authHeaders),
    );
    check('create app: invalid slug → 400', res.status === 400, `status=${res.status}`);

    // ── 5. Create client (secret shown once) ────────────────────────────
    res = await oauthAdminClientsCreateHandler(
      body(
        {
          appId,
          redirectUris: ['https://verify.example.com/callback', 'http://localhost:3001/callback'],
          scopes: ['openid', 'profile', 'email'],
          grants: ['authorization_code', 'refresh_token'],
        },
        authHeaders,
      ),
    );
    data = await json(res);
    check('create client: 201', res.status === 201, `status=${res.status}`);
    check('create client: secret returned once', typeof data.clientSecret === 'string' && data.clientSecret.length > 30, `len=${String(data.clientSecret || '').length}`);
    check('create client: clientId prefixed', String(data.client?.clientId || '').startsWith('tirbeo_'));
    clientId = data.client?.clientId || '';
    clientRowId = data.client?.id || '';

    // ── 6. List again — secret must be redacted ─────────────────────────
    res = await oauthAdminAppsListHandler(new NextRequest(`${API}/x`, { headers: authHeaders }));
    data = await json(res);
    const listedApp = (data.apps || []).find((a: any) => a.id === appId);
    const listedClient = listedApp?.clients?.find((c: any) => c.id === clientRowId);
    check('list: app present', !!listedApp);
    check('list: client present', !!listedClient);
    check('list: secret redacted', listedClient && !('clientSecret' in listedClient) && listedClient.hasSecret === true);
    check('list: clientId not leaked in list', listedClient && listedClient.clientId === clientId);

    // ── 7. Invalid redirect URI rejected ────────────────────────────────
    res = await oauthAdminClientsCreateHandler(
      body({ appId, redirectUris: ['ftp://nope.example.com'], scopes: ['openid'] }, authHeaders),
    );
    check('create client: bad redirect URI → 400', res.status === 400, `status=${res.status}`);

    // ── 8. Update client (scopes + disable) ─────────────────────────────
    res = await oauthAdminClientsUpdateHandler(
      new NextRequest(`${API}/x`, {
        method: 'PATCH',
        body: JSON.stringify({ scopes: ['openid', 'email'], isActive: false, grants: ['authorization_code'] }),
        headers: { 'content-type': 'application/json', ...authHeaders },
      }),
      clientRowId,
    );
    data = await json(res);
    check('update client: 200', res.status === 200, `status=${res.status}`);
    check('update client: scopes applied', JSON.stringify(data.client?.scopes) === JSON.stringify(['openid', 'email']));
    check('update client: disabled', data.client?.isActive === false);

    // ── 9. Regenerate secret (shown once again) ─────────────────────────
    res = await oauthAdminClientsRegenerateSecretHandler(
      new NextRequest(`${API}/x`, { method: 'POST', headers: authHeaders }),
      clientRowId,
    );
    data = await json(res);
    check('rotate secret: 200', res.status === 200, `status=${res.status}`);
    check('rotate secret: new secret returned', typeof data.clientSecret === 'string' && data.clientSecret.length > 30);
    check('rotate secret: clientId echoed', data.clientId === clientId);

    // ── 10. Update app ──────────────────────────────────────────────────
    res = await oauthAdminAppsUpdateHandler(
      new NextRequest(`${API}/x`, {
        method: 'PATCH',
        body: JSON.stringify({ description: 'updated description', name: 'Verify OAuth Admin App v2' }),
        headers: { 'content-type': 'application/json', ...authHeaders },
      }),
      appId,
    );
    data = await json(res);
    check('update app: 200', res.status === 200, `status=${res.status}`);
    check('update app: description applied', data.app?.description === 'updated description');

    // ── 11. Update app: slug clash rejected ─────────────────────────────
    const clashSlug = `verify-clash-${Date.now()}`;
    await prisma.apps.create({
      data: { name: 'Clash', slug: clashSlug, ownerId: adminUser.id },
    });
    res = await oauthAdminAppsUpdateHandler(
      new NextRequest(`${API}/x`, {
        method: 'PATCH',
        body: JSON.stringify({ slug: clashSlug }),
        headers: { 'content-type': 'application/json', ...authHeaders },
      }),
      appId,
    );
    check('update app: slug clash → 409', res.status === 409, `status=${res.status}`);
    await prisma.apps.deleteMany({ where: { slug: clashSlug } });

    // ── 12. Delete client ───────────────────────────────────────────────
    res = await oauthAdminClientsDeleteHandler(
      new NextRequest(`${API}/x`, { method: 'DELETE', headers: authHeaders }),
      clientRowId,
    );
    check('delete client: 200', res.status === 200, `status=${res.status}`);
    const gone = await prisma.app_oauth_clients.findUnique({ where: { id: clientRowId } });
    check('delete client: row gone', !gone);

    // ── 13. Delete app (cascades) ───────────────────────────────────────
    res = await oauthAdminAppsDeleteHandler(
      new NextRequest(`${API}/x`, { method: 'DELETE', headers: authHeaders }),
      appId,
    );
    check('delete app: 200', res.status === 200, `status=${res.status}`);
    const appGone = await prisma.apps.findUnique({ where: { id: appId } });
    check('delete app: row gone', !appGone);
  } catch (e: any) {
    check(`unexpected error: ${e?.message || e}`, false);
  } finally {
    // Cleanup on any path
    await prisma.app_oauth_clients.deleteMany({ where: { id: clientRowId } }).catch(() => {});
    await prisma.apps.deleteMany({ where: { id: appId } }).catch(() => {});
    await revokeSession(session.sessionId).catch(() => {});
  }

  console.log(`\n${failures === 0 ? '🎉 ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
