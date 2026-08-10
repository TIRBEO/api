import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { prisma } from './db/prisma';
import { getSession } from './session';

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return new TextEncoder().encode(secret);
}

const JWT_ISSUER = process.env.JWT_ISSUER || 'api.tirbeo.app';

// Friendly labels for well-known scopes (apps can override via app_permissions).
const SCOPE_LABELS: Record<string, string> = {
  profile: 'Profile',
  email: 'Email address',
  openid: 'Sign you in',
};
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  profile: 'View your name and public profile photo',
  email: 'View your email address',
  openid: 'Verify your identity and sign you in',
};

// Short-lived consent tickets bind the consent screen the user actually saw to
// the approve POST — a code can only be issued with a ticket that was issued
// for this user + client + exact scopes. In-memory (single API instance, same
// as the rate limiter); one-shot and expires after 10 minutes.
interface ConsentTicket {
  userId: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
}
const consentTickets = new Map<string, ConsentTicket>();
const TICKET_TTL_MS = 10 * 60 * 1000;

function issueConsentTicket(userId: string, clientId: string, scopes: string[]): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const ticket = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  consentTickets.set(ticket, {
    userId,
    clientId,
    scopes: [...scopes],
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  if (consentTickets.size > 500) {
    for (const [k, v] of consentTickets) {
      if (v.expiresAt < Date.now()) consentTickets.delete(k);
    }
  }
  return ticket;
}

function consumeConsentTicket(ticket: string, userId: string, clientId: string, requestedScopes: string[]): boolean {
  if (!ticket) return false;
  const t = consentTickets.get(ticket);
  if (!t) return false;
  consentTickets.delete(ticket); // one-shot
  if (t.expiresAt < Date.now()) return false;
  if (t.userId !== userId || t.clientId !== clientId) return false;
  // No scope escalation: everything requested must have been shown on the
  // consent screen the user approved.
  return requestedScopes.every((s) => t.scopes.includes(s));
}

async function verifyAccessToken(token: string): Promise<{ userId: string; clientId: string; scopes: string[] } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'], issuer: JWT_ISSUER });
    if (payload.purpose !== 'access_token' || !payload.sub || !payload.clientId) return null;
    if (payload.aud && payload.aud !== payload.clientId) return null;
    if (!payload.jti) return null;
    // The token is only valid while its DB row is unrevoked and unexpired —
    // revocation must actually kill the token (JWTs alone can't be recalled).
    const row = await prisma.access_tokens.findUnique({ where: { token: payload.jti as string } });
    if (!row || row.revokedAt || row.expiresAt < new Date()) return null;
    return {
      userId: payload.sub as string,
      clientId: payload.clientId as string,
      scopes: (payload.scopes as string[]) || [],
    };
  } catch { return null; }
}

async function generateTokens(clientId: string, userId: string, scopes: string[]) {
  const accessTokenId = randomUUID();
  const accessToken = await new SignJWT({
    sub: userId,
    clientId,
    scopes,
    purpose: 'access_token',
    jti: accessTokenId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(JWT_ISSUER)
    .setAudience(clientId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(getSecret());

  const refreshTokenId = randomUUID();
  const refreshTokenStr = `rt_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;

  await prisma.access_tokens.create({
    data: {
      id: accessTokenId,
      clientId,
      userId,
      // Store the unique JWT id (jti) — the JWT itself must never be truncated
      // into the unique column: its header+payload prefix is identical for
      // every token of the same user, which breaks uniqueness on rotation.
      token: accessTokenId,
      scopes,
      expiresAt: new Date(Date.now() + 3600000),
    },
  });

  await prisma.refresh_tokens.create({
    data: {
      id: refreshTokenId,
      clientId,
      userId,
      token: refreshTokenStr,
      scopes,
      expiresAt: new Date(Date.now() + 2592000000),
    },
  });

  return { accessToken, refreshToken: refreshTokenStr, expiresIn: 3600 };
}

/**
 * Consent-screen details for a pending "Login with Tirbeo" request.
 * GET /api/auth/oauth/consent?client_id=…&redirect_uri=…&scope=…&response_type=code
 * Requires a signed-in session; returns the app, readable scope list and any
 * prior consent so the UI can show the right screen (or auto-continue).
 */
export async function oauthConsentInfoHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated', loginRequired: true }, { status: 401 });
    }

    const params = request.nextUrl.searchParams;
    const clientId = params.get('client_id') || '';
    const redirectUri = params.get('redirect_uri') || '';
    const responseType = params.get('response_type') || 'code';
    const scope = params.get('scope') || '';

    if (responseType !== 'code') {
      return NextResponse.json({ error: 'Unsupported response type' }, { status: 400 });
    }

    const client = await prisma.app_oauth_clients.findUnique({ where: { clientId } });
    if (!client || !client.isActive) {
      return NextResponse.json({ error: 'Invalid client' }, { status: 400 });
    }
    const allowedRedirects = client.redirectUris as string[];
    if (!allowedRedirects.includes(redirectUri)) {
      return NextResponse.json({ error: 'Invalid redirect URI' }, { status: 400 });
    }

    const allowedScopes = client.scopes as string[];
    const requestedScopes = scope ? scope.split(/\s+/).filter(Boolean) : [];
    const validScopes = requestedScopes.filter((s) => allowedScopes.includes(s));

    const [app, prior, perms] = await Promise.all([
      prisma.apps.findUnique({ where: { id: client.appId }, select: { name: true, url: true, icon: true, description: true } }),
      prisma.oAuthConsent.findUnique({ where: { clientId_userId: { clientId, userId: session.userId } } }),
      prisma.app_permissions.findMany({
        where: { appId: client.appId, key: { in: validScopes } },
        select: { key: true, name: true, description: true },
      }),
    ]);

    const permMap = new Map(perms.map((p) => [p.key, p]));
    const consentedScopes = (prior?.scopes as string[]) || [];

    return NextResponse.json({
      client: {
        id: client.clientId,
        name: app?.name || client.clientId,
        url: app?.url || undefined,
        icon: app?.icon || undefined,
        description: app?.description || undefined,
      },
      requestedScopes: validScopes,
      knownScopes: validScopes.map((s) => {
        const p = permMap.get(s);
        return {
          key: s,
          label: p?.name || SCOPE_LABELS[s] || s,
          description: p?.description || SCOPE_DESCRIPTIONS[s] || undefined,
        };
      }),
      hasPriorConsent: !!prior,
      consentedScopes,
      pendingScopes: validScopes.filter((s) => !consentedScopes.includes(s)),
      // One-shot ticket the approve POST must present (bound to this user,
      // client and exact scope set).
      requestTicket: issueConsentTicket(session.userId, clientId, validScopes),
    });
  } catch (err: any) {
    console.error('[OAUTH-CONSENT-INFO]', err?.message || err);
    return NextResponse.json({ error: 'Failed to load consent details' }, { status: 500 });
  }
}

export async function oauthAuthorizeHandler(request: NextRequest) {
  try {
    // Per-IP rate limit (same helper the token endpoint uses).
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
    if (!checkWindowLimit(`oauth-authorize:ip:${clientIp}`, 30, 15 * 60 * 1000)) {
      return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });
    }

    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated', loginRequired: true }, { status: 401 });
    }

    // Per-user limit so one account can't flood authorizations across IPs.
    if (!checkWindowLimit(`oauth-authorize:user:${session.userId}`, 60, 15 * 60 * 1000)) {
      return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });
    }

    const { clientId, redirectUri, scopes, state, responseType, codeChallenge, codeChallengeMethod, approved, requestTicket } = (await request.json()) as any;
    if (responseType !== 'code') {
      return NextResponse.json({ error: 'Unsupported response type' }, { status: 400 });
    }

    // PKCE (RFC 7636) is REQUIRED for every authorization code (RFC 9700
    // recommendation) — a code must never be redeemable with a verifier the
    // client didn't commit to up front. Only S256 is accepted.
    const method = String(codeChallengeMethod || '').toUpperCase();
    const challenge = typeof codeChallenge === 'string' ? codeChallenge.trim() : '';
    if (!challenge || method !== 'S256') {
      return NextResponse.json(
        { error: 'PKCE required: send code_challenge with code_challenge_method=S256' },
        { status: 400 },
      );
    }
    // RFC 7636: S256 challenges are 43-char base64url strings (unpadded).
    if (!/^[A-Za-z0-9\-_]{43,128}$/.test(challenge)) {
      return NextResponse.json({ error: 'Malformed code_challenge' }, { status: 400 });
    }

    const client = await prisma.app_oauth_clients.findUnique({ where: { clientId } });
    if (!client || !client.isActive) {
      return NextResponse.json({ error: 'Invalid client' }, { status: 400 });
    }

    const allowedRedirects = client.redirectUris as string[];
    if (!allowedRedirects.includes(redirectUri)) {
      return NextResponse.json({ error: 'Invalid redirect URI' }, { status: 400 });
    }

    const allowedScopes = client.scopes as string[];
    const requestedScopes = (scopes as string[]) || [];
    const validScopes = requestedScopes.filter(s => allowedScopes.includes(s));

    // Explicit user approval is the consent boundary — a code is only issued
    // after the signed-in user approved on the consent screen. Denying returns
    // an access_denied redirect to the app.
    if (approved !== true) {
      if (approved === false) {
        const denyUrl = new URL(redirectUri);
        denyUrl.searchParams.set('error', 'access_denied');
        if (state) denyUrl.searchParams.set('state', state);
        return NextResponse.json({ redirectUrl: denyUrl.toString(), approved: false });
      }
      return NextResponse.json({ error: 'User approval required' }, { status: 400 });
    }

    // The approve must present the ticket from the consent screen the user
    // actually saw — prevents scripted approvals for scopes never shown.
    if (!consumeConsentTicket(String(requestTicket || ''), session.userId, clientId, validScopes)) {
      return NextResponse.json(
        { error: 'Authorization expired — please start the sign-in again' },
        { status: 400 },
      );
    }

    const code = `ac_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    await prisma.authorization_codes.create({
      data: {
        clientId,
        userId: session.userId,
        code,
        redirectUri,
        scopes: validScopes,
        expiresAt: new Date(Date.now() + 60000),
        codeChallenge: challenge,
        codeChallengeMethod: method,
      },
    });

    const existingConsent = await prisma.oAuthConsent.findUnique({
      where: { clientId_userId: { clientId, userId: session.userId } },
    });
    if (existingConsent) {
      const mergedScopes = [...new Set([...(existingConsent.scopes as string[]), ...validScopes])];
      await prisma.oAuthConsent.update({
        where: { id: existingConsent.id },
        data: { scopes: mergedScopes },
      });
    } else {
      await prisma.oAuthConsent.create({
        data: { clientId, userId: session.userId, scopes: validScopes },
      });
    }

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

    return NextResponse.json({ redirectUrl: redirectUrl.toString() });
  } catch (err: any) {
    console.error('[OAUTH-AUTHORIZE]', err?.message || err, err?.stack);
    return NextResponse.json({ error: 'Authorization failed' }, { status: 500 });
  }
}

export async function oauthTokenHandler(request: NextRequest) {
  try {
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
    if (!checkWindowLimit(`oauth-token:ip:${clientIp}`, 30, 15 * 60 * 1000)) {
      return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });
    }
    const body: any = await request.json();
    const { grantType, code, refreshToken, clientId, clientSecret, redirectUri, codeVerifier } = body;

    if (grantType === 'authorization_code') {
      if (!code || !clientId || !redirectUri) {
        return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
      }

const client = await prisma.app_oauth_clients.findUnique({ where: { clientId } });
      if (!client || !client.isActive) {
        return NextResponse.json({ error: 'Invalid client' }, { status: 400 });
      }
      if (client.clientSecret && client.clientSecret !== clientSecret) {
        return NextResponse.json({ error: 'Invalid client secret' }, { status: 401 });
      }

      const authCode = await prisma.authorization_codes.findUnique({ where: { code } });
      if (!authCode || authCode.expiresAt < new Date()) {
        return NextResponse.json({ error: 'Invalid or expired authorization code' }, { status: 400 });
      }
      if (authCode.clientId !== clientId) {
        return NextResponse.json({ error: 'Client mismatch' }, { status: 400 });
      }
      if (authCode.redirectUri !== redirectUri) {
        return NextResponse.json({ error: 'Redirect URI mismatch' }, { status: 400 });
      }

      // PKCE is enforced at redemption too: a code without an S256 challenge
      // (e.g. issued before PKCE-only enforcement) must not be redeemable.
      if (!authCode.codeChallenge || authCode.codeChallengeMethod !== 'S256') {
        return NextResponse.json({ error: 'This authorization code requires PKCE' }, { status: 400 });
      }
      // RFC 7636: verifiers are 43–128 chars of unreserved ASCII.
      if (typeof codeVerifier !== 'string' || !/^[A-Za-z0-9\-_.~]{43,128}$/.test(codeVerifier)) {
        return NextResponse.json({ error: 'Code verifier required' }, { status: 400 });
      }
      const encoder = new TextEncoder();
      const challenge = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
      const expectedChallenge = btoa(String.fromCharCode(...new Uint8Array(challenge)))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      if (authCode.codeChallenge !== expectedChallenge) {
        return NextResponse.json({ error: 'Code verifier mismatch' }, { status: 400 });
      }

      // Atomic single-use redemption: only succeed if the code is still unused.
      const redemptions = await prisma.authorization_codes.updateMany({
        where: { id: authCode.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (redemptions.count === 0) {
        return NextResponse.json({ error: 'Authorization code already used' }, { status: 400 });
      }

      const tokens = await generateTokens(clientId, authCode.userId, authCode.scopes as string[]);
      return NextResponse.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: (authCode.scopes as string[]).join(' '),
      });
    }

    if (grantType === 'refresh_token') {
      if (!refreshToken || !clientId) {
        return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
      }

      const stored = await prisma.refresh_tokens.findUnique({ where: { token: refreshToken } });
      if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
        return NextResponse.json({ error: 'Invalid or expired refresh token' }, { status: 400 });
      }
      if (stored.clientId !== clientId) {
        return NextResponse.json({ error: 'Client mismatch' }, { status: 400 });
      }

      // Atomic single-use rotation: only one grant may consume this token.
      const rotated = await prisma.refresh_tokens.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (rotated.count === 0) {
        return NextResponse.json({ error: 'Refresh token already used' }, { status: 400 });
      }
      await prisma.access_tokens.updateMany({
        where: { userId: stored.userId, clientId: stored.clientId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const tokens = await generateTokens(clientId, stored.userId, stored.scopes as string[]);
      return NextResponse.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: (stored.scopes as string[]).join(' '),
      });
    }

    return NextResponse.json({ error: 'Unsupported grant type' }, { status: 400 });
  } catch (err: any) {
    console.error('[OAUTH-TOKEN]', err?.message || err);
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 500 });
  }
}

export async function oauthRevokeHandler(request: NextRequest) {
  try {
    const { token, tokenTypeHint } = (await request.json()) as any;
    if (!token) {
      return NextResponse.json({ error: 'Token required' }, { status: 400 });
    }

    if (tokenTypeHint === 'refresh_token' || token.startsWith('rt_')) {
      const stored = await prisma.refresh_tokens.findUnique({ where: { token } });
      if (stored && !stored.revokedAt) {
        await prisma.refresh_tokens.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      }
    }

    // Access tokens: resolve the presented JWT to its stored jti and revoke the
    // row (the DB row is what verifyAccessToken enforces).
    if (!token.startsWith('rt_')) {
      try {
        const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'], issuer: JWT_ISSUER });
        if (payload.purpose === 'access_token' && payload.jti) {
          await prisma.access_tokens.updateMany({
            where: { token: payload.jti as string, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
      } catch {
        // Unverifiable token — nothing to revoke.
      }
    }

    return NextResponse.json({});
  } catch (err: any) {
    console.error('[OAUTH-REVOKE]', err?.message || err);
    return NextResponse.json({ error: 'Revocation failed' }, { status: 500 });
  }
}

export async function oidcUserInfoHandler(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      return NextResponse.json({ error: 'No token provided' }, { status: 401 });
    }

    const payload = await verifyAccessToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, name: true, photoUrl: true, emailVerified: true },
    });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const result: Record<string, any> = { sub: user.id };
    const scopes = payload.scopes || [];
    if (scopes.includes('profile')) {
      result.name = user.name;
      result.picture = user.photoUrl;
    }
    if (scopes.includes('email')) {
      result.email = user.email;
      result.email_verified = user.emailVerified;
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to get user info' }, { status: 500 });
  }
}
