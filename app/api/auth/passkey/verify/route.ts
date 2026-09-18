import { NextRequest, NextResponse } from 'next/server';
import { verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { createSession, setSessionCookie } from '@/features/auth/session';
import { describeDevice, createNotification } from '@/features/notifications/notifications';
import { logSecurityEvent } from '@/features/security/security';
import { createAuditEvent } from '@/features/security/audit';
import { getAndConsumeChallenge } from '@/features/auth/passkeys/challenge-store';

export const runtime = 'nodejs';

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { credential, mode, challengeNonce, deviceName } = body as {
      credential: RegistrationResponseJSON | AuthenticationResponseJSON;
      mode: 'register' | 'login';
      challengeNonce?: string;
      deviceName?: string;
    };

    if (!credential?.id) {
      return NextResponse.json({ error: 'Invalid credential' }, { status: 400 });
    }

    const rpID = getRpID(req);
    const origin = getOrigin(req);

    // ── Login mode ──
    if (mode === 'login') {
      const authCred = credential as AuthenticationResponseJSON;
      const storedChallenge = getAndConsumeChallenge(challengeNonce || '');
      if (!storedChallenge) {
        return NextResponse.json({ error: 'Passkey challenge expired. Please try again.' }, { status: 400 });
      }

      const passkey = await prisma.passkey.findUnique({
        where: { credentialId: authCred.id },
        include: { user: { select: { id: true, email: true, isBanned: true, isSuspended: true } } },
      });
      if (!passkey) {
        return NextResponse.json({ error: 'Passkey not found' }, { status: 404 });
      }
      if (passkey.user.isBanned) {
        return NextResponse.json({ error: 'Account suspended' }, { status: 403 });
      }
      if (passkey.user.isSuspended) {
        return NextResponse.json({ error: 'Account suspended' }, { status: 403 });
      }

      const verification = await verifyAuthenticationResponse({
        response: authCred,
        expectedChallenge: storedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
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
        data: {
          counter: BigInt(verification.authenticationInfo.newCounter),
          updatedAt: new Date(),
        },
      });

      const userAgent = req.headers.get('user-agent') || '';
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
      const { token, refreshToken } = await createSession(passkey.userId, userAgent, ip);

      logSecurityEvent({
        request: req,
        userId: passkey.userId,
        eventType: 'auth.login_success',
        details: { reason: 'passkey' },
      }).catch(() => {});

      const { recordLoginHistory } = await import('@/features/security/security');
      const user = await prisma.user.findUnique({ where: { id: passkey.userId }, select: { email: true } });
      recordLoginHistory({
        request: req,
        userId: passkey.userId,
        email: user?.email || '',
        success: true,
        method: 'passkey',
      }).catch(() => {});

      createNotification({
        userId: passkey.userId,
        type: 'security',
        title: 'Signed in with passkey',
        body: `Signed in from ${describeDevice(userAgent)} (IP ${ip || 'unknown'}).`,
        link: '/account/security',
        metadata: { method: 'passkey', ip, device: describeDevice(userAgent) },
      }).catch((e: any) => console.error('[NOTIFICATION]', e?.message));

      createAuditEvent({
        actorId: passkey.userId,
        action: 'user.login',
        targetType: 'user',
        targetId: passkey.userId,
        metadata: { method: 'passkey', ip, device: describeDevice(userAgent) },
      }).catch(() => {});

      const res = NextResponse.json({ ok: true, token });
      setSessionCookie(res, token, refreshToken, req);
      return res;
    }

    // ── Register mode ──
    const session = await getSession(req);
    if (!session?.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const regCred = credential as RegistrationResponseJSON;
    const storedChallenge = getAndConsumeChallenge(session.userId);
    if (!storedChallenge) {
      return NextResponse.json({ error: 'Passkey challenge expired. Please try again.' }, { status: 400 });
    }

    const verification = await verifyRegistrationResponse({
      response: regCred,
      expectedChallenge: storedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json({ error: 'Registration verification failed' }, { status: 400 });
    }

    const { credential: regInfo } = verification.registrationInfo;
    const transports = regCred.response?.transports || [];
    const ua = req.headers.get('user-agent') || '';
    const deviceNameStr = deviceName || parseDeviceName(ua);

    await prisma.passkey.create({
      data: {
        userId: session.userId,
        credentialId: regInfo.id,
        credentialPublicKey: Buffer.from(regInfo.publicKey),
        counter: BigInt(regInfo.counter),
        transports: transports.join(','),
        deviceName: deviceNameStr,
      },
    });

    createAuditEvent({
      actorId: session.userId,
      action: 'user.passkey.registered',
      targetType: 'user',
      targetId: session.userId,
      metadata: { credentialId: regInfo.id, deviceName: deviceNameStr },
    }).catch(() => {});

    createNotification({
      userId: session.userId,
      type: 'security',
      title: 'New passkey added',
      body: `A new passkey (${deviceNameStr}) was registered. You can now sign in with it.`,
      link: '/account/security',
    }).catch((e: any) => console.error('[NOTIFICATION]', e?.message));

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PASSKEY VERIFY]', err?.message || err);
    return NextResponse.json({ error: 'Passkey verification failed' }, { status: 500 });
  }
}
