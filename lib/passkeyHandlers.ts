import { NextRequest, NextResponse } from 'next/server';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { prisma } from './db/prisma';
import { getSession, createSession, setSessionCookie } from './session';
import { createAuditEvent } from './audit';
import { jsonError, jsonUnauthorized } from './response';

const RP_NAME = 'Tirbeo';
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isLocalhost(host: string): boolean {
  return host.startsWith('localhost') || host.startsWith('127.0.0.1');
}

// WebAuthn rpID must be a registrable-domain suffix of the page's origin.
// In local dev the dashboard is served from localhost, so use "localhost";
// in production the API and dashboard share the .tirbeo.app registrable domain.
function getRpID(request: NextRequest): string {
  const host = request.headers.get('host') || '';
  const origin = request.headers.get('origin') || '';
  
  // If the origin is from localhost, use localhost as RP ID
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (isLocalhost(originUrl.hostname)) return 'localhost';
    } catch {}
  }
  
  // Fallback to host-based detection
  if (isLocalhost(host)) return 'localhost';
  
  // Production: use the configured domain
  return process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
}

function getOrigin(request: NextRequest): string {
  const origin = request.headers.get('origin');
  if (origin) return origin;
  const host = request.headers.get('host') || '';
  if (isLocalhost(host)) return `http://${host}`;
  return `https://${host}`;
}

// ─── In-memory challenge cache ────────────────────────
// Challenges are short-lived (5 min) so in-memory is fine.
const challengeCache = new Map<string, { challenge: string; type: 'register' | 'auth'; userId?: string; expiresAt: number }>();

function storeChallenge(nonce: string, challenge: string, type: 'register' | 'auth', userId?: string) {
  // Lazy cleanup
  const now = Date.now();
  for (const [k, v] of challengeCache) {
    if (v.expiresAt < now) challengeCache.delete(k);
  }
  challengeCache.set(nonce, { challenge, type, userId, expiresAt: now + CHALLENGE_TTL_MS });
  console.log(`[PASSKEY] Stored ${type} challenge with nonce: ${nonce}`);
}

function getAndDeleteChallenge(nonce: string) {
  const row = challengeCache.get(nonce);
  if (!row) return null;
  challengeCache.delete(nonce);
  if (row.expiresAt < Date.now()) return null;
  return row;
}

// ─── Registration: generate options ────────────────────────

export async function passkeyRegisterOptionsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      console.warn('[PASSKEY REGISTER OPTIONS] No session found');
      return jsonUnauthorized(undefined, request);
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) {
      console.warn(`[PASSKEY REGISTER OPTIONS] User not found: ${session.userId}`);
      return jsonError('User not found', 404, request);
    }

    const existingPasskeys = await prisma.passkey.findMany({
      where: { userId: user.id },
      select: { credentialId: true },
    });

    const rpID = getRpID(request);
    console.log(`[PASSKEY REGISTER OPTIONS] Generating options for user ${user.email}, rpID: ${rpID}`);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: user.email,
      userDisplayName: user.name || user.email,
      attestationType: 'none',
      excludeCredentials: existingPasskeys.map((pk) => ({ id: pk.credentialId })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    const nonce = crypto.randomUUID();
    await storeChallenge(nonce, options.challenge, 'register', user.id);
    console.log(`[PASSKEY REGISTER OPTIONS] Challenge stored with nonce: ${nonce}`);

    const res = NextResponse.json({ publicKey: options, challengeNonce: nonce });
    return res;
  } catch (err: any) {
    console.error('[PASSKEY REGISTER OPTIONS] Error:', err?.message || err, err?.stack);
    return jsonError('Failed to generate registration options: ' + (err?.message || 'unknown error'), 500, request);
  }
}

// ─── Registration: verify response ─────────────────────────

export async function passkeyRegisterVerifyHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      console.warn('[PASSKEY REGISTER VERIFY] No session found');
      return jsonUnauthorized(undefined, request);
    }

    const body: any = await request.json();
    const { credential, deviceName, challengeNonce } = body as {
      credential: RegistrationResponseJSON;
      deviceName?: string;
      challengeNonce?: string;
    };

    if (!credential) {
      console.warn('[PASSKEY REGISTER VERIFY] Missing credential in request body');
      return jsonError('Missing credential', 400, request);
    }
    if (!challengeNonce) {
      console.warn('[PASSKEY REGISTER VERIFY] Missing challengeNonce in request body');
      return jsonError('Missing challengeNonce', 400, request);
    }

    console.log(`[PASSKEY REGISTER VERIFY] Verifying registration for user ${session.userId}, nonce: ${challengeNonce}`);

    const stored = await getAndDeleteChallenge(challengeNonce);
    if (!stored) {
      console.warn(`[PASSKEY REGISTER VERIFY] Challenge not found or expired: ${challengeNonce}`);
      return jsonError('Challenge expired or not found. Please try again.', 400, request);
    }

    const origin = getOrigin(request);
    const rpID = getRpID(request);
    console.log(`[PASSKEY REGISTER VERIFY] Using origin: ${origin}, rpID: ${rpID}`);

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      console.warn('[PASSKEY REGISTER VERIFY] Verification failed - not verified or no registrationInfo');
      return jsonError('Registration verification failed', 400, request);
    }

    const { credential: regCredential } = verification.registrationInfo;
    const transports = credential.response?.transports || [];
    const deviceNameStr = deviceName || parseDeviceName(request.headers.get('user-agent') || '');

    console.log(`[PASSKEY REGISTER VERIFY] Creating passkey with credentialId: ${regCredential.id}`);

    await prisma.passkey.create({
      data: {
        userId: session.userId,
        credentialId: regCredential.id,
        credentialPublicKey: Buffer.from(regCredential.publicKey),
        counter: BigInt(regCredential.counter),
        transports: transports.join(','),
        deviceName: deviceNameStr,
      },
    });

    console.log(`[PASSKEY REGISTER VERIFY] Passkey created successfully for user ${session.userId}`);

    await createAuditEvent({
      actorId: session.userId,
      action: 'passkey.registered',
      targetType: 'user',
      targetId: session.userId,
      metadata: { deviceName: deviceNameStr },
      severity: 'info',
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PASSKEY REGISTER VERIFY] Error:', err?.message || err, err?.stack);
    return jsonError('Failed to verify registration: ' + (err?.message || 'unknown error'), 500, request);
  }
}

// ─── Authentication: generate options ──────────────────────

export async function passkeyAuthOptionsHandler(request: NextRequest) {
  try {
    const body: any = await request.json().catch(() => ({}));
    const { email } = body as { email?: string };

    let allowCredentials: { id: string; transports?: AuthenticatorTransport[] }[] = [];

    if (email) {
      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (user) {
        const passkeys = await prisma.passkey.findMany({
          where: { userId: user.id },
          select: { credentialId: true, transports: true },
        });
        allowCredentials = passkeys.map((pk) => ({
          id: pk.credentialId,
          transports: pk.transports
            ? (pk.transports.split(',') as AuthenticatorTransport[])
            : undefined,
        }));
      }
    }

    const options = await generateAuthenticationOptions({
      rpID: getRpID(request),
      allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
      userVerification: 'preferred',
    });

    const nonce = crypto.randomUUID();
    await storeChallenge(nonce, options.challenge, 'auth');

    const res = NextResponse.json({ publicKey: options, challengeNonce: nonce });
    return res;
  } catch (err: any) {
    console.error('[PASSKEY AUTH OPTIONS]', err?.message || err);
    return jsonError('Failed to generate authentication options', 500, request);
  }
}

// ─── Authentication: verify response ───────────────────────

export async function passkeyAuthVerifyHandler(request: NextRequest) {
  try {
    const body: any = await request.json();
    const { credential, challengeNonce } = body as {
      credential: AuthenticationResponseJSON;
      challengeNonce: string;
    };

    if (!credential || !challengeNonce) return jsonError('Missing credential or challenge', 400, request);

    const stored = await getAndDeleteChallenge(challengeNonce);
    if (!stored) {
      return jsonError('Challenge expired. Please try again.', 400, request);
    }

    const passkey = await prisma.passkey.findUnique({
      where: { credentialId: credential.id },
      include: { user: { select: { id: true, email: true, isBanned: true, isSuspended: true } } },
    });

    if (!passkey) return jsonError('Passkey not found. It may have been deleted.', 404, request);
    if (passkey.user.isBanned) return jsonError('Account suspended', 403, request);
    if (passkey.user.isSuspended) return jsonError('Account suspended', 403, request);

    const origin = getOrigin(request);

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: getRpID(request),
      requireUserVerification: false,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.credentialPublicKey),
        counter: Number(passkey.counter),
        transports: passkey.transports
          ? (passkey.transports.split(',') as AuthenticatorTransport[])
          : undefined,
      },
    });

    if (!verification.verified) {
      return jsonError('Authentication verification failed', 400, request);
    }

    // Update counter
    await prisma.passkey.update({
      where: { id: passkey.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter) },
    });

    // Create session
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const { token, refreshToken } = await createSession(
      passkey.user.id,
      request.headers.get('user-agent') || undefined,
      ip,
    );

    await createAuditEvent({
      actorId: passkey.user.id,
      action: 'passkey.authenticated',
      targetType: 'user',
      targetId: passkey.user.id,
      metadata: { passkeyId: passkey.id, deviceName: passkey.deviceName },
      severity: 'info',
    });

    const res = NextResponse.json({
      id: passkey.user.id,
      email: passkey.user.email,
    });
     setSessionCookie(res, token, refreshToken, request);
    return res;
  } catch (err: any) {
    console.error('[PASSKEY AUTH VERIFY]', err?.message || err);
    return jsonError('Failed to verify authentication: ' + (err?.message || 'unknown error'), 500, request);
  }
}

// ─── List passkeys ─────────────────────────────────────────

export async function passkeyListHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized(undefined, request);

    const passkeys = await prisma.passkey.findMany({
      where: { userId: session.userId },
      select: {
        id: true,
        deviceName: true,
        transports: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ passkeys });
  } catch (err: any) {
    console.error('[PASSKEY LIST]', err?.message || err);
    return jsonError('Failed to list passkeys', 500, request);
  }
}

// ─── Delete passkey ────────────────────────────────────────

export async function passkeyDeleteHandler(request: NextRequest, passkeyId: string) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized(undefined, request);

    const passkey = await prisma.passkey.findUnique({
      where: { id: passkeyId },
      select: { userId: true, deviceName: true },
    });

    if (!passkey) return jsonError('Passkey not found', 404, request);
    if (passkey.userId !== session.userId) return jsonError('Forbidden', 403, request);

    await prisma.passkey.delete({ where: { id: passkeyId } });

    await createAuditEvent({
      actorId: session.userId,
      action: 'passkey.deleted',
      targetType: 'user',
      targetId: session.userId,
      metadata: { passkeyId, deviceName: passkey.deviceName },
      severity: 'warning',
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PASSKEY DELETE]', err?.message || err);
    return jsonError('Failed to delete passkey', 500, request);
  }
}

// ─── Update passkey name ───────────────────────────────────

export async function passkeyUpdateHandler(request: NextRequest, passkeyId: string) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized(undefined, request);

    const body: any = await request.json();
    const { deviceName } = body as { deviceName?: string };

    if (typeof deviceName !== 'string') return jsonError('Invalid device name', 400, request);

    const passkey = await prisma.passkey.findUnique({
      where: { id: passkeyId },
      select: { userId: true },
    });

    if (!passkey) return jsonError('Passkey not found', 404, request);
    if (passkey.userId !== session.userId) return jsonError('Forbidden', 403, request);

    await prisma.passkey.update({
      where: { id: passkeyId },
      data: { deviceName: deviceName || null },
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PASSKEY UPDATE]', err?.message || err);
    return jsonError('Failed to update passkey', 500, request);
  }
}

// ─── Helpers ───────────────────────────────────────────────

function parseDeviceName(ua: string): string {
  if (!ua) return 'Unknown device';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) {
    const match = ua.match(/;\s*([^;)]+)\s*Build/);
    return match ? match[1].trim() : 'Android device';
  }
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux device';
  return 'Unknown device';
}
