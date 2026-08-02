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

async function verifyAccessToken(token: string): Promise<{ userId: string; clientId: string; scopes: string[] } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'], issuer: JWT_ISSUER });
    if (payload.purpose !== 'access_token' || !payload.sub || !payload.clientId) return null;
    if (payload.aud && payload.aud !== payload.clientId) return null;
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
      token: accessToken.slice(0, 64),
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

export async function oauthAuthorizeHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated', loginRequired: true }, { status: 401 });
    }

    const { clientId, redirectUri, scopes, state, responseType } = await request.json();
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
    const requestedScopes = (scopes as string[]) || [];
    const validScopes = requestedScopes.filter(s => allowedScopes.includes(s));

    const code = `ac_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    await prisma.authorization_codes.create({
      data: {
        clientId,
        userId: session.userId,
        code,
        redirectUri,
        scopes: validScopes,
        expiresAt: new Date(Date.now() + 60000),
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
    const body = await request.json();
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

      if (authCode.codeChallenge && authCode.codeChallengeMethod === 'S256') {
        if (!codeVerifier) {
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

      await prisma.refresh_tokens.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
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
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 500 });
  }
}

export async function oauthRevokeHandler(request: NextRequest) {
  try {
    const { token, tokenTypeHint } = await request.json();
    if (!token) {
      return NextResponse.json({ error: 'Token required' }, { status: 400 });
    }

    if (tokenTypeHint === 'refresh_token' || token.startsWith('rt_')) {
      const stored = await prisma.refresh_tokens.findUnique({ where: { token } });
      if (stored && !stored.revokedAt) {
        await prisma.refresh_tokens.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      }
    }

    const stored = await prisma.access_tokens.findFirst({ where: { token: token.slice(0, 64) } });
    if (stored && !stored.revokedAt) {
      await prisma.access_tokens.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    }

    return NextResponse.json({});
  } catch (err: any) {
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
