import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { generateSecret, generateTotpUri, verifyTotp as verifyTotpCode } from './auth/totp';
import { verifyPassword } from './auth/password';
import { createAuditEvent } from './audit';
import { randomInt } from 'crypto';

// GET /api/security/events — security audit events for current user
export async function securityEventsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    const events = await prisma.auditEvent.findMany({
      where: { actorId: session.userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, action: true, metadata: true, createdAt: true },
    });

    const formatted = events.map(e => ({
      id: e.id,
      type: mapActionToType(e.action),
      description: describeAction(e.action),
      date: e.createdAt.toISOString(),
      ip: (e.metadata as any)?.ip || undefined,
      location: (e.metadata as any)?.location || undefined,
      userAgent: (e.metadata as any)?.userAgent || undefined,
    }));

    return NextResponse.json({ events: formatted });
  } catch (err: any) {
    console.error('[SECURITY EVENTS]', err?.message || err);
    return NextResponse.json({ events: [] });
  }
}

// POST /api/security/totp/setup — generate TOTP secret
export async function totpSetupHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, email: true } });
    if (!user) return new NextResponse('User not found', { status: 404 });

    const secret = generateSecret();
    const uri = generateTotpUri(secret, user.email);

    await prisma.user.update({
      where: { id: session.userId },
      data: { totpSecret: secret },
    });

    return NextResponse.json({ secret, uri });
  } catch (err: any) {
    console.error('[TOTP SETUP]', err?.message || err);
    return new NextResponse('Failed to setup TOTP', { status: 500 });
  }
}

// POST /api/security/totp/verify — verify and enable TOTP
export async function totpVerifyHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    const { code } = await request.json();
    if (typeof code !== 'string' || code.length !== 6) {
      return new NextResponse('Invalid code', { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, totpSecret: true, is2FAEnabled: true } });
    if (!user || !user.totpSecret) {
      return new NextResponse('No TOTP secret found. Run setup first.', { status: 400 });
    }

    const ok = await verifyTotpCode(code, user.totpSecret);
    if (!ok) return new NextResponse('Invalid code', { status: 400 });

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
  } catch (err: any) {
    console.error('[TOTP VERIFY]', err?.message || err);
    return new NextResponse('Failed to verify TOTP', { status: 500 });
  }
}

// DELETE /api/security/totp/disable — disable TOTP
export async function totpDisableHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    const body = await request.json().catch(() => ({}));
    const { password, totpCode } = body as { password?: string; totpCode?: string };

    if (!password && !totpCode) {
      return new NextResponse('Password or TOTP code required to disable 2FA', { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, passwordHash: true, totpSecret: true, is2FAEnabled: true },
    });
    if (!user) return new NextResponse('User not found', { status: 404 });
    if (!user.is2FAEnabled) return new NextResponse('2FA is not enabled', { status: 400 });

    if (password) {
      if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
        return new NextResponse('Incorrect password', { status: 401 });
      }
    } else if (totpCode) {
      if (!user.totpSecret) return new NextResponse('No TOTP secret', { status: 400 });
      const ok = await verifyTotpCode(totpCode, user.totpSecret);
      if (!ok) return new NextResponse('Invalid TOTP code', { status: 401 });
    }

    await prisma.user.update({
      where: { id: session.userId },
      data: { totpSecret: null, is2FAEnabled: false },
    });

    await prisma.recoveryCode.deleteMany({ where: { userId: session.userId } });

    await createAuditEvent({
      actorId: session.userId,
      action: '2fa.disabled',
      targetType: 'user',
      targetId: session.userId,
      severity: 'warning',
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[TOTP DISABLE]', err?.message || err);
    return new NextResponse('Failed to disable TOTP', { status: 500 });
  }
}

// POST /api/security/backup-codes/regenerate — regenerate backup codes
export async function backupCodesRegenerateHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    const codes = Array.from({ length: 10 }, () =>
      Array.from({ length: 8 }, () => '0123456789'[randomInt(10)]).join('')
    );

    await prisma.recoveryCode.deleteMany({ where: { userId: session.userId } });
    await prisma.recoveryCode.createMany({
      data: codes.map(code => ({ userId: session.userId, code })),
    });

    return NextResponse.json({ codes });
  } catch (err: any) {
    console.error('[BACKUP CODES]', err?.message || err);
    return new NextResponse('Failed to regenerate codes', { status: 500 });
  }
}

// POST /api/security/phones — add phone
export async function phonesAddHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    const { number } = await request.json();
    if (!number || typeof number !== 'string') {
      return new NextResponse('Phone number required', { status: 400 });
    }
    const clean = number.replace(/[\s\-()]/g, '');
    if (!/^(\+?\d{7,15}|\d{10})$/.test(clean)) {
      return new NextResponse('Invalid phone number format', { status: 400 });
    }

    await prisma.user.update({
      where: { id: session.userId },
      data: { phoneNumber: clean },
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PHONES ADD]', err?.message || err);
    return new NextResponse('Failed to add phone', { status: 500 });
  }
}

// DELETE /api/security/phones — remove phone
export async function phonesRemoveHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    await prisma.user.update({
      where: { id: session.userId },
      data: { phoneNumber: null },
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[PHONES REMOVE]', err?.message || err);
    return new NextResponse('Failed to remove phone', { status: 500 });
  }
}

// PUT /api/security/recovery-email — update recovery email
export async function recoveryEmailHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email required', { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new NextResponse('Invalid email format', { status: 400 });
    }

    await prisma.user.update({
      where: { id: session.userId },
      data: { secondaryEmail: email },
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[RECOVERY EMAIL]', err?.message || err);
    return new NextResponse('Failed to update recovery email', { status: 500 });
  }
}

// POST /api/security/password-check — check password strength
export async function passwordCheckHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    const { password } = await request.json().catch(() => ({ password: '' }));
    if (!password || typeof password !== 'string') {
      return new NextResponse('Password required', { status: 400 });
    }

    let strength = 0;
    if (password.length >= 8) strength++;
    if (password.length >= 12) strength++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength++;
    if (/\d/.test(password)) strength++;
    if (/[^a-zA-Z0-9]/.test(password)) strength++;
    const weak = strength < 3 ? 1 : 0;

    let reused = 0;
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { passwordHash: true },
    });
    if (user?.passwordHash) {
      const { verifyPassword } = await import('./auth/password');
      if (await verifyPassword(user.passwordHash, password)) reused = 1;
    }

    return NextResponse.json({ weak, reused, strength, total: 1 });
  } catch (err: any) {
    console.error('[PASSWORD CHECK]', err?.message || err);
    return new NextResponse('Failed to check passwords', { status: 500 });
  }
}

// DELETE /api/security/sessions/revoke-all — revoke all other sessions
export async function sessionsRevokeAllHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    await prisma.session.deleteMany({
      where: { userId: session.userId, NOT: { id: session.sessionId } },
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[SESSIONS REVOKE ALL]', err?.message || err);
    return new NextResponse('Failed to revoke sessions', { status: 500 });
  }
}

// DELETE /api/security/sessions/[id] — revoke specific session
export async function sessionRevokeHandler(request: NextRequest, sessionId: string) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    if (sessionId === session.sessionId) {
      return new NextResponse('Cannot terminate current session', { status: 400 });
    }

    const target = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!target || target.userId !== session.userId) {
      return new NextResponse('Session not found', { status: 404 });
    }

    await prisma.session.delete({ where: { id: sessionId } });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[SESSION REVOKE]', err?.message || err);
    return new NextResponse('Failed to revoke session', { status: 500 });
  }
}

function mapActionToType(action: string): string {
  if (action.includes('login') || action.includes('sign_in')) return 'sign_in';
  if (action.includes('password') || action.includes('password.reset')) return 'password_change';
  if (action === '2fa.enabled' || action === '2fa.setup') return '2fa_enable';
  if (action === '2fa.disabled') return '2fa_disable';
  if (action.includes('recovery')) return 'recovery_change';
  if (action.includes('session') && action.includes('delete')) return 'session_revoke';
  if (action.includes('passkey') || action.includes('webauthn')) return 'passkey_add';
  return 'sign_in';
}

function describeAction(action: string): string {
  const map: Record<string, string> = {
    'user.login': 'Signed in',
    'user.created': 'Account created',
    'password.reset': 'Password changed',
    '2fa.enabled': '2-step verification enabled',
    '2fa.disabled': '2-step verification disabled',
    '2fa.setup': 'Authenticator app configured',
    '2fa.recovery_codes_regenerated': 'Backup codes regenerated',
  };
  return map[action] || action.replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
