import { NextRequest, NextResponse } from 'next/server';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransport } from '@simplewebauthn/server';
import { prisma } from '@/infrastructure/db/prisma';
import { storeChallenge, getAndConsumeChallenge } from '@/features/auth/passkeys/challenge-store';
import { createSession, setSessionCookie } from '@/features/auth/session';
import { logSecurityEvent } from '@/features/security/security';
import { createAuditEvent } from '@/features/security/audit';

export const runtime = 'nodejs';

/* ── rpID / origin resolution — mirrors apps/api/app/api/auth/passkey/* ── */
function getRpID(req: NextRequest): string {
  const origin = req.headers.get('origin') || '';
  if (origin) {
    try {
      const h = new URL(origin).hostname;
      if (h === 'localhost' || h === '127.0.0.1') return 'localhost';
    } catch {}
  }
  const host = req.headers.get('host') || '';
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return 'localhost';
  return process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
}

function getOrigin(req: NextRequest): string {
  const origin = req.headers.get('origin');
  if (origin) return origin;
  const host = req.headers.get('host') || '';
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return `http://${host}`;
  return `https://${host}`;
}

/**
 * POST /api/admin/passkey/options
 * Body: { email?: string }
 * Returns WebAuthn authentication options scoped to the email's passkeys
 * (or discoverable credentials when no email given), plus a challenge nonce.
 */
export async function adminPasskeyOptionsHandler(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { email?: string };
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';

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
          transports: pk.transports ? (pk.transports.split(',') as AuthenticatorTransport[]) : undefined,
        }));
      }
    }

    const options = await generateAuthenticationOptions({
      rpID: getRpID(req),
      allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
      userVerification: 'preferred',
    });

    const nonce = crypto.randomUUID();
    storeChallenge(nonce, options.challenge);

    return NextResponse.json({ publicKey: options, challengeNonce: nonce });
  } catch (err: any) {
    console.error('[ADMIN PASSKEY OPTIONS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to generate passkey options' }, { status: 500 });
  }
}

/**
 * POST /api/admin/passkey/verify
 * Body: { credential, challengeNonce }
 * Verifies the WebAuthn assertion, requires the user to hold an adminRole,
 * then mints a full session (cookie + bearer token) — exactly like the
 * password admin login.
 */
export async function adminPasskeyVerifyHandler(req: NextRequest) {
  try {
    const body = await req.json();
    const { credential, challengeNonce } = body as {
      credential?: AuthenticationResponseJSON;
      challengeNonce?: string;
    };

    if (!credential?.id) {
      return NextResponse.json({ error: 'Invalid credential' }, { status: 400 });
    }

    const storedChallenge = getAndConsumeChallenge(challengeNonce || '');
    if (!storedChallenge) {
      return NextResponse.json({ error: 'Passkey challenge expired. Please try again.' }, { status: 400 });
    }

    const passkey = await prisma.passkey.findUnique({
      where: { credentialId: credential.id },
      include: { user: { select: { id: true, email: true, name: true, adminRole: true, isBanned: true, isSuspended: true } } },
    });
    if (!passkey) {
      return NextResponse.json({ error: 'Passkey not found' }, { status: 404 });
    }
    if (passkey.user.isBanned || passkey.user.isSuspended) {
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 });
    }
    if (!passkey.user.adminRole) {
      return NextResponse.json(
        { error: 'This account does not have admin access.' },
        { status: 403 },
      );
    }

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: storedChallenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpID(req),
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
      return NextResponse.json({ error: 'Passkey verification failed' }, { status: 400 });
    }

    await prisma.passkey.update({
      where: { id: passkey.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter), updatedAt: new Date() },
    });

    const userAgent = req.headers.get('user-agent') || '';
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { token } = await createSession(passkey.userId, userAgent, ip);

    logSecurityEvent({
      request: req,
      userId: passkey.userId,
      eventType: 'auth.login_success',
      details: { reason: 'passkey', surface: 'admin' },
    }).catch(() => {});

    createAuditEvent({
      actorId: passkey.userId,
      action: 'user.login',
      targetType: 'user',
      targetId: passkey.userId,
      metadata: { method: 'passkey', surface: 'admin', ip },
    }).catch(() => {});

    const res = NextResponse.json({
      ok: true,
      token,
      user: { id: passkey.user.id, email: passkey.user.email, name: passkey.user.name, adminRole: passkey.user.adminRole },
    });
    setSessionCookie(res, token, undefined, req);
    return res;
  } catch (err: any) {
    console.error('[ADMIN PASSKEY VERIFY]', err?.message || err);
    return NextResponse.json({ error: 'Passkey verification failed' }, { status: 500 });
  }
}
