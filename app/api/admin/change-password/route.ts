import { NextRequest, NextResponse } from 'next/server';
import { verifyTempPasswordChangeToken } from '@/lib/auth/jwt';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { prisma } from '@/lib/db/prisma';
import { createSession, setSessionCookie } from '@/lib/session';

export async function POST(request: NextRequest) {
  try {
    const { tempToken, newPassword } = (await request.json()) as any;
    if (!tempToken || !newPassword || typeof newPassword !== 'string') {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    const userId = await verifyTempPasswordChangeToken(tempToken);
    if (!userId) return NextResponse.json({ error: 'Invalid or expired session. Please sign in again.' }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true, adminRole: true, mustChangePassword: true },
    });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (!user.adminRole) {
      return NextResponse.json({ error: 'Access denied. You do not have admin privileges.' }, { status: 403 });
    }

    const { checkPasswordBreach } = await import('@/lib/auth/breach');
    const breach = await checkPasswordBreach(newPassword);
    if (breach.breached) {
      return NextResponse.json({ error: 'This password has been found in known breaches. Please choose a different password.' }, { status: 400 });
    }

    const sameAsTemp = await verifyPassword(user.passwordHash, newPassword);
    if (sameAsTemp) {
      return NextResponse.json({ error: 'New password must be different from the temporary password.' }, { status: 400 });
    }

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash, mustChangePassword: false },
    });

    const ip = request.headers.get('x-forwarded-for') || '';
    const adminRole = user.adminRole;
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip, adminRole);
    const res = NextResponse.json({ id: user.id, email: user.email });
    setSessionCookie(res, token, refreshToken);

    const { logSecurityEvent } = await import('@/lib/security');
    logSecurityEvent({ request, userId: user.id, eventType: 'auth.admin_password_initial_set', details: { reason: 'first_login' } }).catch(() => {});

    return res;
  } catch (err: any) {
    console.error('[ADMIN CHANGE PASSWORD]', err?.message || err);
    return NextResponse.json({ error: 'Failed to set new password' }, { status: 500 });
  }
}
