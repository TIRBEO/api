import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { getSession } from '../../../../lib/session';
import { verifyPassword } from '../../../../lib/auth/password';
import { revokeSession } from '../../../../lib/auth/session';
import { createAuditEvent } from '../../../../lib/audit';
import { logSecurityEvent } from '../../../../lib/security';

export const runtime = 'nodejs';

/**
 * DELETE ACCOUNT — Soft Delete Flow
 *
 * 1. User requests deletion → soft-delete (hide all data immediately)
 * 2. After 30 days → permanent deletion (cron job, irreversible)
 * 3. Even admins cannot recover after permanent deletion
 * 4. During 30-day window, user can contact support to cancel
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { password, reason } = (await request.json()) as any;
    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: 'Password is required' }, { status: 400 });
    }

    // Check if already soft-deleted
    const existingUser = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, passwordHash: true, deletedAt: true, scheduledDeletionAt: true },
    });

    if (!existingUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (existingUser.deletedAt) {
      return NextResponse.json({ error: 'Account is already scheduled for deletion' }, { status: 400 });
    }

    // Verify password
    if (!existingUser.passwordHash) {
      return NextResponse.json({ error: 'Account has no password set' }, { status: 400 });
    }

    const isValid = await verifyPassword(existingUser.passwordHash, password);
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    // ─── Step 1: Revoke all sessions immediately ───
    await prisma.session.updateMany({
      where: { userId: session.userId, status: 'active' },
      data: { status: 'revoked', revokedAt: new Date() },
    });

    // ─── Step 2: Soft-delete — hide all user data ───
    // The user row stays but is marked deleted. All queries exclude deletedAt != null.
    logSecurityEvent({ request, userId: session.userId, eventType: 'security.deletion_scheduled', severity: 'warning', details: { reason: reason || 'user_requested' } }).catch(() => {});
    const scheduledDeletionAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await prisma.user.update({
      where: { id: session.userId },
      data: {
        deletedAt: new Date(),
        scheduledDeletionAt,
        deletionReason: reason || 'user_requested',
        // Scrub PII immediately
        name: null,
        bio: null,
        photoUrl: null,
        phoneNumber: null,
        secondaryEmail: null,
        googleId: null,
        githubId: null,
        discordId: null,
        occupation: null,
        companyName: null,
        companyRole: null,
        website: null,
        linkedin: null,
        githubUsername: null,
        twitter: null,
        // Keep email as `deleted-{userId}@tirbeo.app` for uniqueness
        email: `deleted-${session.userId}@tirbeo.app`,
        // Clear OAuth tokens
        totpSecret: null,
        is2FAEnabled: false,
      },
    });

    // ─── Step 3: Delete all user data immediately ───
    // Cascade handles most relations, but delete critical ones explicitly
    const deleteOps = [
      prisma.apiKey.deleteMany({ where: { userId: session.userId } }),
      prisma.otp.deleteMany({ where: { userId: session.userId } }),
      prisma.user.update({ where: { id: session.userId }, data: { backupCodes: [] } }),
      prisma.passkey.deleteMany({ where: { userId: session.userId } }),
      prisma.notification.deleteMany({ where: { userId: session.userId } }),
      prisma.securityEvent.deleteMany({ where: { userId: session.userId } }),
      prisma.media.deleteMany({ where: { uploadedBy: session.userId } }),
      prisma.login_history.deleteMany({ where: { userId: session.userId } }),
      prisma.ticket.deleteMany({ where: { customerId: session.userId } }),
      prisma.ticketMessage.deleteMany({ where: { authorId: session.userId } }),
    ];

    await Promise.allSettled(deleteOps);

    // ─── Step 4: Audit log (with the original email) ───
    await createAuditEvent({
      actorId: session.userId,
      action: 'user.soft_delete',
      targetType: 'user',
      targetId: session.userId,
      metadata: {
        email: existingUser.email,
        scheduledDeletionAt: scheduledDeletionAt.toISOString(),
        reason: reason || 'user_requested',
      },
    }).catch(() => {});

    // ─── Step 5: Clear session cookie ───
    const response = NextResponse.json({
      success: true,
      message: 'Account scheduled for permanent deletion in 30 days. Contact support@tirbeo.app to cancel.',
      scheduledDeletionAt: scheduledDeletionAt.toISOString(),
    });

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

/**
 * GET — Check deletion status
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Auth required' }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { deletedAt: true, scheduledDeletionAt: true },
    });

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    return NextResponse.json({
      deleted: !!user.deletedAt,
      deletedAt: user.deletedAt?.toISOString() || null,
      scheduledDeletionAt: user.scheduledDeletionAt?.toISOString() || null,
      daysRemaining: user.scheduledDeletionAt
        ? Math.max(0, Math.ceil((new Date(user.scheduledDeletionAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
        : null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

/**
 * PATCH — Cancel deletion (within 30-day window)
 */
export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Auth required' }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { deletedAt: true, scheduledDeletionAt: true, email: true },
    });

    if (!user?.deletedAt) {
      return NextResponse.json({ error: 'Account is not scheduled for deletion' }, { status: 400 });
    }

    // Can only cancel if within 30-day window
    if (user.scheduledDeletionAt && new Date(user.scheduledDeletionAt) < new Date()) {
      return NextResponse.json({ error: 'Deletion window has passed' }, { status: 400 });
    }

    // Restore user
    await prisma.user.update({
      where: { id: session.userId },
      data: {
        deletedAt: null,
        scheduledDeletionAt: null,
        deletionReason: null,
        email: `restored-${session.userId}@tirbeo.app`, // Will need manual email update
      },
    });

    await createAuditEvent({
      actorId: session.userId,
      action: 'user.cancel_deletion',
      targetType: 'user',
      targetId: session.userId,
      metadata: { cancelledAt: new Date().toISOString() },
    }).catch(() => {});
    logSecurityEvent({ request, userId: session.userId, eventType: 'security.deletion_cancelled' }).catch(() => {});

    return NextResponse.json({
      success: true,
      message: 'Deletion cancelled. Please update your email in settings.',
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
