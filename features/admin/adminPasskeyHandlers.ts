import { NextRequest, NextResponse } from 'next/server';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransport } from '@simplewebauthn/server';
import { prisma } from '@/infrastructure/db/prisma';
import { storeChallenge, getAndConsumeChallenge } from '@/features/auth/passkeys/challenge-store';
import { consumeGenericWindow } from '@/features/auth/verify-limits';
import { getAppDomain } from '@/config/app-urls';
import { createSession, setSessionCookie } from '@/features/auth/session';
import { logSecurityEvent } from '@/features/security/security';
import { createAuditEvent } from '@/features/security/audit';
import { clientIpOrUnknown } from '@/shared/client-ip';

export const runtime = 'nodejs';

/* Ceilings on the anonymous passkey-options call. A staff passkey login is
   entered a handful of times a day by real people, so these are wide enough to
   never be felt and narrow enough that the endpoint cannot be walked. */
const PASSKEY_OPTIONS_WINDOW_MS = 15 * 60 * 1000;
const PASSKEY_OPTIONS_PER_ADDRESS = 10;
const PASSKEY_OPTIONS_PER_IP = 30;

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
  return getAppDomain();
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
 * Returns WebAuthn authentication options plus a challenge nonce.
 *
 * The response is deliberately identical whatever the caller types. Scoping
 * `allowCredentials` to an address used to answer "does this staff mailbox
 * exist, and which passkeys hangs off it" to anyone with a curl — and the
 * verifier never needed the list: it looks the credential up by the id the
 * authenticator returns. So `email` is accepted and ignored, and unauthenticated
 * traffic is capped per address and per device.
 */
export async function adminPasskeyOptionsHandler(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { email?: string };
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (email) {
      const ip = clientIpOrUnknown(req.headers);
      const [byAddress, byIp] = await Promise.all([
        consumeGenericWindow(`passkey-options:email:${email}`, PASSKEY_OPTIONS_PER_ADDRESS, PASSKEY_OPTIONS_WINDOW_MS),
        consumeGenericWindow(`passkey-options:ip:${ip}`, PASSKEY_OPTIONS_PER_IP, PASSKEY_OPTIONS_WINDOW_MS),
      ]);
      if (!byAddress.ok || !byIp.ok) {
        return NextResponse.json({ error: 'Too many tries. Wait a minute and try again.' }, { status: 429 });
      }
    }

    const options = await generateAuthenticationOptions({
      rpID: getRpID(req),
      allowCredentials: undefined,
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
 * Verifies the WebAuthn assertion, requires the user to be an admin,
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
      include: { user: { select: { id: true, email: true, status: true, isAdmin: true, profile: { select: { name: true } } } } },
    });
    if (!passkey) {
      return NextResponse.json({ error: 'Passkey not found' }, { status: 404 });
    }
    if (passkey.user.status === 'banned' || passkey.user.status === 'suspended') {
      return NextResponse.json({ error: 'Account suspended' }, { status: 403 });
    }
    if (!passkey.user.isAdmin) {
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
        publicKey: new Uint8Array(passkey.credentialPubkey),
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
    const ip = clientIpOrUnknown(req.headers);
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
      user: { id: passkey.user.id, email: passkey.user.email, name: passkey.user.profile?.name ?? null, adminRole: passkey.user.isAdmin ? 'admin' : null },
    });
    setSessionCookie(res, token, undefined, req);
    return res;
  } catch (err: any) {
    console.error('[ADMIN PASSKEY VERIFY]', err?.message || err);
    return NextResponse.json({ error: 'Passkey verification failed' }, { status: 500 });
  }
}
