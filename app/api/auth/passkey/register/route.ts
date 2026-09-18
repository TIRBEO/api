import { NextRequest, NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
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
    const session = await getSession(req);
    if (!session?.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const rpID = getRpID(req);

    const existingPasskeys = await prisma.passkey.findMany({
      where: { userId: user.id },
      select: { credentialId: true },
    });

    const options = await generateRegistrationOptions({
      rpName: 'Tirbeo',
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

    storeChallenge(session.userId, options.challenge);

    return NextResponse.json({ publicKey: options });
  } catch (err: any) {
    console.error('[PASSKEY REGISTER]', err?.message || err);
    return NextResponse.json({ error: 'Failed to generate passkey options' }, { status: 500 });
  }
}
