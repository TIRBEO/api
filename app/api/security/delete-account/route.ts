import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { getSession } from '../../../../lib/session';
import { verifyPassword } from '../../../../lib/auth/password';
import { revokeSession } from '../../../../lib/auth/session';
import { createAuditEvent } from '../../../../lib/audit';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { password } = await request.json();
    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: 'Password is required' }, { status: 400 });
    }

    // Get user with password hash
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, passwordHash: true },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Verify password
    if (!user.passwordHash) {
      return NextResponse.json({ error: 'Account has no password set' }, { status: 400 });
    }

    const isValid = await verifyPassword(user.passwordHash, password);
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    // Log the deletion request
    await createAuditEvent({
      actorId: session.userId,
      action: 'user.delete_account',
      targetType: 'user',
      targetId: session.userId,
      metadata: { email: user.email },
    }).catch(() => {});

    // Revoke all sessions for this user
    await prisma.session.updateMany({
      where: { userId: session.userId, status: 'active' },
      data: { status: 'revoked', revokedAt: new Date() },
    });

    // Delete user data (cascade should handle most relations)
    // Delete in order to respect foreign key constraints
    await prisma.auditEvent.deleteMany({ where: { actorId: session.userId } });
    await prisma.securityEvent.deleteMany({ where: { userId: session.userId } });
    await prisma.otp.deleteMany({ where: { userId: session.userId } });
    await prisma.recoveryCode.deleteMany({ where: { userId: session.userId } });
    await prisma.passkey.deleteMany({ where: { userId: session.userId } });
    await prisma.apiKey.deleteMany({ where: { userId: session.userId } });
    await prisma.notification.deleteMany({ where: { userId: session.userId } });
    await prisma.notificationPreference.deleteMany({ where: { userId: session.userId } });
    await prisma.pushSubscription.deleteMany({ where: { userId: session.userId } });
    await prisma.session.deleteMany({ where: { userId: session.userId } });
    await prisma.integration.deleteMany({ where: { userId: session.userId } });
    await prisma.media.deleteMany({ where: { uploadedBy: session.userId } });
    await prisma.userRole.deleteMany({ where: { userId: session.userId } });

    // Finally delete the user
    await prisma.user.delete({ where: { id: session.userId } });

    // Clear session cookie
    const response = NextResponse.json({ success: true });
    response.cookies.set('__session', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });

    return response;
  } catch (err: any) {
    console.error('[DELETE ACCOUNT]', err?.message || err);
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
  }
}
