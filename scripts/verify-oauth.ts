/**
 * End-to-end verification of the "Login with Tirbeo" OAuth provider flow.
 *
 * Drives the real route handlers against the live DB:
 *   authorize → authorization code → token exchange → userinfo / refresh / revoke
 *
 * Run from apps/api:  npx tsx --env-file=.env.local scripts/verify-oauth.ts
 * Creates and cleans up its own test app, client, tokens and session.
 */
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { prisma } from '../lib/db/prisma';
import { createSession, revokeSession } from '../lib/auth/session';
import {
  oauthAuthorizeHandler,
  oauthTokenHandler,
  oauthRevokeHandler,
  oidcUserInfoHandler,
  oauthConsentInfoHandler,
} from '../lib/oauthHandlers';

let failures = 0;
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const API = 'http://localhost:3000';
const base64url = (buf: Uint8Array) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function req(url: string, init: RequestInit = {}) {
  return new NextRequest(`${API}${url}`, init);
}

// Unique per-run IPs so repeated runs don't trip each other's rate-limit
// windows (token: 30/15min per IP, authorize: 30/15min per IP).
const testIp = `10.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
const burstIp = `10.200.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

async function main() {
  const user = await prisma.user.findFirst({
    where: { isBanned: false },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, name: true, emailVerified: true },
  });
  if (!user) throw new Error('No user available');
  console.log(`Using user: ${user.email} (${user.id})`);

  // ── Setup: test app + OAuth client (inside try so failures get cleaned up) ──
  let app: any = null;
  let client: any = null;
  let clientId = '';
  let sessionId = '';
  let code = '';
  let accessToken = '';
  let refreshToken = '';

  // PKCE verifier + S256 challenge used by every authorize call in this run
  // (PKCE is now mandatory on the endpoint).
  const verifier = `v_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
  const challenge = base64url(createHash('sha256').update(verifier).digest());

  try {
    const slug = `verify-oauth-${Date.now()}`;
    app = await prisma.apps.create({
      data: { name: 'Verify OAuth App', slug, url: 'https://client.example.com', ownerId: user.id },
    });
    clientId = `verify_${randomUUID().replace(/-/g, '')}`;
    const clientSecret = `cs_${randomUUID().replace(/-/g, '')}`;
    const redirectUri = 'https://client.example.com/callback';
    const scopes = ['profile', 'email'];
    client = await prisma.app_oauth_clients.create({
      data: {
        appId: app.id,
        clientId,
        clientSecret,
        redirectUris: [redirectUri],
        grants: ['authorization_code', 'refresh_token'],
        scopes,
        isActive: true,
        updatedAt: new Date(),
      },
    });
    // ── 0. Consent info (before anything is approved) ────────────────────
    const session = await createSession(user.id);
    sessionId = session.sessionId;

    const consentQs = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'profile email',
      response_type: 'code',
    });
    const consentReq = req(`/api/auth/oauth/consent?${consentQs.toString()}`, {
      headers: { cookie: `__session=${session.token}` },
    });
    const consentRes = await oauthConsentInfoHandler(consentReq);
    const consentJson: any = await consentRes.json();
    check('consent info: 200', consentRes.status === 200, `status=${consentRes.status}`);
    check('consent info: client name + scopes', consentJson?.client?.name === 'Verify OAuth App' && consentJson?.knownScopes?.length === 2);
    check('consent info: scopes pending initially', consentJson?.pendingScopes?.includes('profile') && consentJson?.pendingScopes?.includes('email'));
    check('consent info: ticket issued', typeof consentJson?.requestTicket === 'string' && consentJson.requestTicket.length > 0);

    // One-shot consent tickets are scope-bound — fetch a fresh one per approval.
    const getTicket = async (scopes: string): Promise<string> => {
      const qs = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scopes,
        response_type: 'code',
      });
      const res = await oauthConsentInfoHandler(
        req(`/api/auth/oauth/consent?${qs.toString()}`, { headers: { cookie: `__session=${session.token}` } }),
      );
      const json: any = await res.json();
      return json?.requestTicket || '';
    };
    const ticket = consentJson?.requestTicket || '';

    const noSessionConsent = req(`/api/auth/oauth/consent?${consentQs.toString()}`);
    check('consent info: requires session (401)', (await oauthConsentInfoHandler(noSessionConsent)).status === 401);

    // ── 1. Authorize (signed-in user approves access) ────────────────────
    const authorizeReq = req('/api/auth/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `__session=${session.token}`,
        'x-forwarded-for': testIp,
      },
      body: JSON.stringify({
        responseType: 'code',
        clientId,
        redirectUri,
        scopes,
        state: 'xyz123',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        approved: true,
        requestTicket: ticket,
      }),
    });
    const authorizeRes = await oauthAuthorizeHandler(authorizeReq);
    const authorizeJson: any = await authorizeRes.json();
    check('authorize: 200', authorizeRes.status === 200, `status=${authorizeRes.status}`);
    const parsed = authorizeJson?.redirectUrl ? new URL(authorizeJson.redirectUrl) : null;
    code = parsed?.searchParams.get('code') || '';
    check('authorize: code issued', !!code);
    check('authorize: state echoed', parsed?.searchParams.get('state') === 'xyz123');

    // PKCE is mandatory — authorize without a challenge must be rejected.
    const noPkceReq = req('/api/auth/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `__session=${session.token}`,
        'x-forwarded-for': testIp,
      },
      body: JSON.stringify({ responseType: 'code', clientId, redirectUri, scopes, state: 'nopkce' }),
    });
    const noPkceRes = await oauthAuthorizeHandler(noPkceReq);
    check('authorize: PKCE required (no challenge → 400)', noPkceRes.status === 400, `status=${noPkceRes.status}`);

    // Approval is the consent boundary: missing `approved` must be rejected.
    const noApprovalReq = req('/api/auth/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `__session=${session.token}`,
        'x-forwarded-for': testIp,
      },
      body: JSON.stringify({
        responseType: 'code',
        clientId,
        redirectUri,
        scopes,
        state: 'noapproval',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      }),
    });
    const noApprovalRes = await oauthAuthorizeHandler(noApprovalReq);
    check('authorize: missing approval → 400', noApprovalRes.status === 400, `status=${noApprovalRes.status}`);

    // Approving without the consent ticket must be rejected (consent bypass).
    const noTicketReq = req('/api/auth/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `__session=${session.token}`,
        'x-forwarded-for': testIp,
      },
      body: JSON.stringify({
        responseType: 'code',
        clientId,
        redirectUri,
        scopes,
        state: 'noticket',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        approved: true,
      }),
    });
    const noTicketRes = await oauthAuthorizeHandler(noTicketReq);
    check('authorize: approve without consent ticket → 400', noTicketRes.status === 400, `status=${noTicketRes.status}`);

    // Reusing a consumed ticket must also be rejected.
    const replayTicketReq = req('/api/auth/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `__session=${session.token}`,
        'x-forwarded-for': testIp,
      },
      body: JSON.stringify({
        responseType: 'code',
        clientId,
        redirectUri,
        scopes,
        state: 'replayticket',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        approved: true,
        requestTicket: ticket,
      }),
    });
    const replayTicketRes = await oauthAuthorizeHandler(replayTicketReq);
    check('authorize: consumed ticket replay → 400', replayTicketRes.status === 400, `status=${replayTicketRes.status}`);

    // …and an explicit deny must redirect with access_denied (no code).
    const denyReq = req('/api/auth/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `__session=${session.token}`,
        'x-forwarded-for': testIp,
      },
      body: JSON.stringify({
        responseType: 'code',
        clientId,
        redirectUri,
        scopes: ['profile'],
        state: 'deny1',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        approved: false,
        requestTicket: await getTicket('profile'),
      }),
    });
    const denyRes = await oauthAuthorizeHandler(denyReq);
    const denyJson: any = await denyRes.json();
    const denyUrl = denyJson?.redirectUrl ? new URL(denyJson.redirectUrl) : null;
    check(
      'authorize: deny → access_denied + state',
      denyRes.status === 200 && denyUrl?.searchParams.get('error') === 'access_denied' && denyUrl?.searchParams.get('state') === 'deny1'
    );

    // …and a non-S256 method must be rejected too.
    const plainPkceReq = req('/api/auth/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `__session=${session.token}`,
        'x-forwarded-for': testIp,
      },
      body: JSON.stringify({
        responseType: 'code',
        clientId,
        redirectUri,
        scopes,
        state: 'plain1',
        codeChallenge: challenge,
        codeChallengeMethod: 'plain',
      }),
    });
    const plainPkceRes = await oauthAuthorizeHandler(plainPkceReq);
    check('authorize: plain method rejected (400)', plainPkceRes.status === 400, `status=${plainPkceRes.status}`);

    // ── 2. Token exchange (authorization_code) ───────────────────────────
    const tokenReq = req('/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ grantType: 'authorization_code', code, clientId, clientSecret, redirectUri, codeVerifier: verifier }),
    });
    const tokenRes = await oauthTokenHandler(tokenReq);
    const tokens: any = await tokenRes.json();
    check('token: 200', tokenRes.status === 200, `status=${tokenRes.status}`);
    check('token: access_token + Bearer', !!tokens.access_token && tokens.token_type === 'Bearer');
    check('token: expires_in ~3600', tokens.expires_in === 3600);
    check('token: refresh_token issued', !!tokens.refresh_token);
    check('token: scope echoed', tokens.scope === 'profile email');
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;

    // ── 3. userinfo with access token ────────────────────────────────────
    const uiReq = req('/api/oidc/userinfo', { headers: { authorization: `Bearer ${accessToken}` } });
    const uiRes = await oidcUserInfoHandler(uiReq);
    const ui: any = await uiRes.json();
    check('userinfo: 200', uiRes.status === 200, `status=${uiRes.status}`);
    check('userinfo: sub matches', ui.sub === user.id);
    check('userinfo: email claim', ui.email === user.email);
    check('userinfo: profile name claim', ui.name === user.name);

    // ── 4. Code is single-use ────────────────────────────────────────────
    const replayReq = req('/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ grantType: 'authorization_code', code, clientId, clientSecret, redirectUri, codeVerifier: verifier }),
    });
    const replayRes = await oauthTokenHandler(replayReq);
    check('code replay rejected', replayRes.status === 400, `status=${replayRes.status}`);

    // ── 5. Refresh token rotation ────────────────────────────────────────
    const refreshReq = req('/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ grantType: 'refresh_token', refreshToken, clientId }),
    });
    const refreshRes = await oauthTokenHandler(refreshReq);
    const rotated: any = await refreshRes.json();
    check('refresh: 200 + new tokens', refreshRes.status === 200 && !!rotated.access_token && !!rotated.refresh_token);
    check('refresh: token rotated', rotated.refresh_token !== refreshToken);

    const oldRefreshReq = req('/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ grantType: 'refresh_token', refreshToken, clientId }),
    });
    const oldRefreshRes = await oauthTokenHandler(oldRefreshReq);
    check('refresh: old token rejected after rotation', oldRefreshRes.status === 400, `status=${oldRefreshRes.status}`);

    // ── 6. Revoke + revoked access token must die ────────────────────────
    const revokeReq = req('/api/auth/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ token: rotated.access_token, tokenTypeHint: 'access_token' }),
    });
    const revokeRes = await oauthRevokeHandler(revokeReq);
    check('revoke: 200', revokeRes.status === 200, `status=${revokeRes.status}`);

    const deadUiReq = req('/api/oidc/userinfo', { headers: { authorization: `Bearer ${rotated.access_token}` } });
    const deadUiRes = await oidcUserInfoHandler(deadUiReq);
    check('userinfo: revoked access token rejected', deadUiRes.status === 401, `status=${deadUiRes.status}`);

    // ── 7. PKCE (S256) enforcement at redemption ─────────────────────────
    const pkceCodeReq = req('/api/auth/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `__session=${session.token}`,
        'x-forwarded-for': testIp,
      },
      body: JSON.stringify({
        responseType: 'code',
        clientId,
        redirectUri,
        scopes: ['profile'],
        state: 'pkce1',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        approved: true,
        requestTicket: await getTicket('profile'),
      }),
    });
    const pkceAuthRes = await oauthAuthorizeHandler(pkceCodeReq);
    const pkceAuthJson: any = await pkceAuthRes.json();
    const pkceCode = pkceAuthJson?.redirectUrl ? new URL(pkceAuthJson.redirectUrl).searchParams.get('code') : '';

    // Wrong verifier must be rejected…
    const wrongVerifierReq = req('/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ grantType: 'authorization_code', code: pkceCode, clientId, clientSecret, redirectUri, codeVerifier: 'wrong-verifier' }),
    });
    const wrongVerifierRes = await oauthTokenHandler(wrongVerifierReq);
    check('PKCE: wrong verifier rejected', wrongVerifierRes.status === 400, `status=${wrongVerifierRes.status}`);

    // …and the correct one must succeed.
    const pkceCode2Req = req('/api/auth/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `__session=${session.token}`,
        'x-forwarded-for': testIp,
      },
      body: JSON.stringify({
        responseType: 'code',
        clientId,
        redirectUri,
        scopes: ['profile'],
        state: 'pkce2',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        approved: true,
        requestTicket: await getTicket('profile'),
      }),
    });
    const pkce2AuthJson: any = await (await oauthAuthorizeHandler(pkceCode2Req)).json();
    const pkce2Code = pkce2AuthJson?.redirectUrl ? new URL(pkce2AuthJson.redirectUrl).searchParams.get('code') : '';
    const goodVerifierReq = req('/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ grantType: 'authorization_code', code: pkce2Code, clientId, clientSecret, redirectUri, codeVerifier: verifier }),
    });
    const goodVerifierRes = await oauthTokenHandler(goodVerifierReq);
    check('PKCE: correct verifier succeeds', goodVerifierRes.status === 200, `status=${goodVerifierRes.status}`);

    // ── 8. Security checks ───────────────────────────────────────────────
    const badSecretReq = req('/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ grantType: 'authorization_code', code: pkce2Code, clientId, clientSecret: 'wrong', redirectUri, codeVerifier: verifier }),
    });
    check('token: wrong client secret rejected', (await oauthTokenHandler(badSecretReq)).status === 401);

    // ── 9. Rate limit on authorize ───────────────────────────────────────
    // Fire authorize from a fresh per-run IP until the per-IP window
    // (30/15min) trips → 429. Requests carry NO session so they don't consume
    // the per-user budget (60/15min) and the script stays re-runnable.
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const burstReq = req('/api/auth/oauth/authorize', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': burstIp,
        },
        body: JSON.stringify({
          responseType: 'code',
          clientId,
          redirectUri,
          scopes: ['profile'],
          state: `burst${i}`,
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
        }),
      });
      const burstRes = await oauthAuthorizeHandler(burstReq);
      if (burstRes.status === 429) { limited = true; break; }
    }
    check('authorize: rate limited (429)', limited, limited ? '' : 'no 429 within 40 requests');
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────
    try { await revokeSession(sessionId); } catch {}
    try { await prisma.session.deleteMany({ where: { id: sessionId } }); } catch {}
    await prisma.authorization_codes.deleteMany({ where: { clientId } });
    await prisma.access_tokens.deleteMany({ where: { clientId } });
    await prisma.refresh_tokens.deleteMany({ where: { clientId } });
    await prisma.oAuthConsent.deleteMany({ where: { clientId } });
    if (client) await prisma.app_oauth_clients.deleteMany({ where: { id: client.id } });
    if (app) await prisma.apps.deleteMany({ where: { id: app.id } });
    console.log('Cleanup done.');
  }

  console.log(failures === 0 ? '\n🎉 ALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ERROR', e?.message || e);
  process.exit(2);
});
