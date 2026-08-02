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
const RP_ID = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getOrigin(request: NextRequest): string {
  const origin = request.headers.get('origin');
  if (origin) return origin;
  const host = request.headers.get('host') || RP_ID;
  return `https://${host}`;
}

// ─── DB-backed challenge helpers ────────────────────────

async function storeChallenge(nonce: string, challenge: string, type: 'register' | 'auth', userId?: string) {
  // Lazy cleanup: delete expired challenges on each write (no cron needed for serverless)
  await prisma.passkeyChallenge.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  await prisma.passkeyChallenge.create({
    data: {
      nonce,
      challenge,
      type,
      userId: userId || null,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });
}

async function getAndDeleteChallenge(nonce: string) {
  const row = await prisma.passkeyChallenge.findUnique({ where: { nonce } });
  if (!row) return null;
  // Delete regardless of expiry
  await prisma.passkeyChallenge.delete({ where: { nonce } });
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

// ─── Registration: generate options ────────────────────────

export async function passkeyRegisterOptionsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized(undefined, request);

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) return jsonError('User not found', 404, request);

    const existingPasskeys = await prisma.passkey.findMany({
      where: { userId: user.id },
      select: { credentialId: true },
    });

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
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

    const res = NextResponse.json({ publicKey: options, challengeNonce: nonce });
    return res;
  } catch (err: any) {
    console.error('[PASSKEY REGISTER OPTIONS]', err?.message || err);
    return jsonError('Failed to generate registration options', 500, request);
  }
}

// ─── Registration: verify response ─────────────────────────

export async function passkeyRegisterVerifyHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized(undefined, request);

    const body = await request.json();
    const { credential, deviceName, challengeNonce } = body as {
      credential: RegistrationResponseJSON;
      deviceName?: string;
      challengeNonce?: string;
    };

    if (!credential) return jsonError('Missing credential', 400, request);
    if (!challengeNonce) return jsonError('Missing challengeNonce', 400, request);

    const stored = await getAndDeleteChallenge(challengeNonce);
    if (!stored) {
      return jsonError('Challenge expired or not found. Please try again.', 400, request);
    }

    const origin = getOrigin(request);

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return jsonError('Registration verification failed', 400, request);
    }

    const { credential: regCredential } = verification.registrationInfo;
    const transports = credential.response?.transports || [];

    await prisma.passkey.create({
      data: {
        userId: session.userId,
        credentialId: regCredential.id,
        credentialPublicKey: Buffer.from(regCredential.publicKey),
        counter: BigInt(regCredential.counter),
        transports: transports.join(','),
        deviceName: deviceName || parseDeviceName(request.headers.get('user-agent') || ''),
      },
    });

    await createAuditEvent({
      actorId: session.userId,
      action: 'passkey.registered',
      targetType: 'user',
      targetId: session.userId,
      metadata: { deviceName: deviceName || undefined },
      severity: 'info',
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PASSKEY REGISTER VERIFY]', err?.message || err);
    return jsonError('Failed to verify registration: ' + (err?.message || 'unknown error'), 500, request);
  }
}

// ─── Authentication: generate options ──────────────────────

export async function passkeyAuthOptionsHandler(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
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
      rpID: RP_ID,
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
    const body = await request.json();
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
      expectedRPID: RP_ID,
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
     setSessionCookie(res, token, refreshToken);
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

    const body = await request.json();
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
