import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { createAuditEvent } from '@/features/security/audit';
import { logSecurityEvent } from '@/features/security/security';
import { requireReauth } from '@/features/auth/reauth';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const session = await getSession(req);
    if (!session?.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const passkeys = await prisma.passkey.findMany({
      where: { userId: session.userId },
      select: { id: true, credentialId: true, transports: true, deviceName: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ passkeys });
  } catch (err: any) {
    console.error('[PASSKEYS LIST]', err?.message || err);
    return NextResponse.json({ error: 'Failed to list passkeys' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession(req);
    if (!session?.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { passkeyId } = body as { passkeyId?: string };
    if (!passkeyId) {
      return NextResponse.json({ error: 'passkeyId required' }, { status: 400 });
    }

    // Removing a credential is a sensitive action — require a fresh identity
    // proof (passkey assertion, password, or TOTP) like DELETE /api/auth/passkey/:id.
    const proof = await requireReauth(req, session.userId);
    if ('response' in proof) return proof.response;

    const passkey = await prisma.passkey.findFirst({
      where: { id: passkeyId, userId: session.userId },
      select: { id: true, deviceName: true },
    });

    if (!passkey) {
      return NextResponse.json({ error: 'Passkey not found' }, { status: 404 });
    }

    await prisma.passkey.delete({ where: { id: passkey.id } });

    createAuditEvent({
      actorId: session.userId,
      action: 'user.passkey.deleted',
      targetType: 'user',
      targetId: session.userId,
      metadata: { passkeyId: passkey.id, deviceName: passkey.deviceName, reauthMethod: proof.method },
    }).catch(() => {});

    logSecurityEvent({
      request: req,
      userId: session.userId,
      eventType: 'security.passkey_deleted',
      details: { passkeyId: passkey.id, deviceName: passkey.deviceName },
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PASSKEYS DELETE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to delete passkey' }, { status: 500 });
  }
}
