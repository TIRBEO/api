import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { requireAdmin } from './session';
import { generateSecret, generateTotpUri, verifyTotp, generateRecoveryCodes } from './auth/totp';
import { hashRecoveryCode } from './auth/password';
import { createAuditEvent } from './audit';

export async function setup2faHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) return new NextResponse('User not found', { status: 404 });
  if (user.is2FAEnabled) return new NextResponse('2FA already enabled', { status: 409 });

  const secret = generateSecret();
  const uri = generateTotpUri(secret, user.email);

  const recoveryCodes = generateRecoveryCodes(8);

  await prisma.user.update({
    where: { id: session.userId },
    data: { totpSecret: secret },
  });

  await prisma.user.update({
    where: { id: session.userId },
    data: { backupCodes: recoveryCodes.map(code => ({ code: hashRecoveryCode(code), used: false })) },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: '2fa.setup',
    targetType: 'user',
    targetId: session.userId,
    severity: 'warning',
  });

  return NextResponse.json({ secret, uri, recoveryCodes });
}

export async function verify2faSetupHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const { token } = (await request.json()) as any;
  if (typeof token !== 'string') return new NextResponse('Invalid token', { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || !user.totpSecret) return new NextResponse('No 2FA secret found. Run setup first.', { status: 400 });

  if (!await verifyTotp(token, user.totpSecret)) {
    return new NextResponse('Invalid code', { status: 400 });
  }

  await prisma.user.update({
    where: { id: session.userId },
    data: { is2FAEnabled: true },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: '2fa.enabled',
    targetType: 'user',
    targetId: session.userId,
    severity: 'warning',
  });

  return NextResponse.json({ ok: true });
}

export async function disable2faHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const { token, password } = (await request.json()) as any;

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) return new NextResponse('User not found', { status: 404 });

  if (token) {
    if (!user.totpSecret || !await verifyTotp(token, user.totpSecret)) {
      return new NextResponse('Invalid 2FA code', { status: 400 });
    }
  } else if (password) {
    const { verifyPassword } = await import('./auth/password');
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) return new NextResponse('Invalid password', { status: 400 });
  } else {
    return new NextResponse('Provide either 2FA code or password', { status: 400 });
  }

  await prisma.user.update({
    where: { id: session.userId },
    data: { totpSecret: null, is2FAEnabled: false },
  });

  await prisma.user.update({
    where: { id: session.userId },
    data: { backupCodes: [] },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: '2fa.disabled',
    targetType: 'user',
    targetId: session.userId,
    severity: 'warning',
  });

  return NextResponse.json({ ok: true });
}

export async function status2faHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { is2FAEnabled: true, totpSecret: true },
  });

  const fullUser = await prisma.user.findUnique({ where: { id: session.userId }, select: { backupCodes: true } });
  const allCodes = Array.isArray((fullUser as any)?.backupCodes) ? (fullUser as any).backupCodes as any[] : [];
  const recoveryCount = allCodes.filter((c: any) => !c.used).length;

  return NextResponse.json({
    enabled: user?.is2FAEnabled || false,
    remainingRecoveryCodes: recoveryCount,
  });
}

export async function regenerateRecoveryCodesHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || !user.is2FAEnabled) {
    return new NextResponse('2FA must be enabled first', { status: 400 });
  }

  const codes = generateRecoveryCodes(8);
  await prisma.user.update({
    where: { id: session.userId },
    data: { backupCodes: codes.map(code => ({ code: hashRecoveryCode(code), used: false })) },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: '2fa.recovery_codes_regenerated',
    targetType: 'user',
    targetId: session.userId,
    severity: 'warning',
  });

  return NextResponse.json({ recoveryCodes: codes });
}
