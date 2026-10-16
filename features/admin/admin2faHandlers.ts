import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requireAdmin } from '@/features/auth/http-guards';
import { generateSecret, generateTotpUri, verifyTotp, generateRecoveryCodes } from '@/features/auth/totp';
import { hashRecoveryCode } from '@/features/auth/password';
import { createAuditEvent } from '@/features/security/audit';

export async function setup2faHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } });
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const security = await prisma.userSecurity.findUnique({ where: { userId: session.userId } });
  if (security?.totpEnabled) return NextResponse.json({ error: '2FA already enabled' }, { status: 409 });

  const secret = generateSecret();
  const uri = generateTotpUri(secret, user.email);

  const recoveryCodes = generateRecoveryCodes(8);

  await prisma.userSecurity.upsert({
    where: { userId: session.userId },
    create: { userId: session.userId, totpSecret: secret, backupCodes: recoveryCodes.map(code => ({ code: hashRecoveryCode(code), used: false })) },
    update: { totpSecret: secret, backupCodes: recoveryCodes.map(code => ({ code: hashRecoveryCode(code), used: false })) },
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
  if (typeof token !== 'string') return NextResponse.json({ error: 'Invalid token' }, { status: 400 });

  const security = await prisma.userSecurity.findUnique({ where: { userId: session.userId } });
  if (!security || !security.totpSecret) return NextResponse.json({ error: 'No 2FA secret found. Run setup first.' }, { status: 400 });

  if (!await verifyTotp(token, security.totpSecret)) {
    return NextResponse.json({ error: 'Invalid code' }, { status: 400 });
  }

  await prisma.userSecurity.update({
    where: { userId: session.userId },
    data: { totpEnabled: true },
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

  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { passwordHash: true } });
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const security = await prisma.userSecurity.findUnique({ where: { userId: session.userId } });

  if (token) {
    if (!security?.totpSecret || !await verifyTotp(token, security.totpSecret)) {
      return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 400 });
    }
  } else if (password) {
    const { verifyPassword } = await import('@/features/auth/password');
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) return NextResponse.json({ error: 'Invalid password' }, { status: 400 });
  } else {
    return NextResponse.json({ error: 'Provide either 2FA code or password' }, { status: 400 });
  }

  await prisma.userSecurity.upsert({
    where: { userId: session.userId },
    create: { userId: session.userId, totpSecret: null, totpEnabled: false, backupCodes: [] },
    update: { totpSecret: null, totpEnabled: false, backupCodes: [] },
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

  const security = await prisma.userSecurity.findUnique({
    where: { userId: session.userId },
    select: { totpEnabled: true, backupCodes: true },
  });

  const allCodes = Array.isArray((security as any)?.backupCodes) ? (security as any).backupCodes as any[] : [];
  const recoveryCount = allCodes.filter((c: any) => !c.used).length;

  return NextResponse.json({
    enabled: security?.totpEnabled || false,
    remainingRecoveryCodes: recoveryCount,
  });
}

export async function regenerateRecoveryCodesHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const security = await prisma.userSecurity.findUnique({ where: { userId: session.userId } });
  if (!security || !security.totpEnabled) {
    return NextResponse.json({ error: '2FA must be enabled first' }, { status: 400 });
  }

  const codes = generateRecoveryCodes(8);
  await prisma.userSecurity.update({
    where: { userId: session.userId },
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
