import { NextRequest, NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { prisma } from '@/infrastructure/db/prisma';
import { storeChallenge } from '@/features/auth/passkeys/challenge-store';

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
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

    const rpID = getRpID(req);

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
      userVerification: 'preferred',
    });

    const nonce = crypto.randomUUID();
    storeChallenge(nonce, options.challenge);

    return NextResponse.json({ publicKey: options, challengeNonce: nonce });
  } catch (err: any) {
    console.error('[PASSKEY AUTH OPTIONS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to generate auth options' }, { status: 500 });
  }
}
