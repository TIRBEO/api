import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { requireReauth } from '@/features/auth/reauth';
import { revokeSessionFamilyByUser } from '@/features/auth/session';
import { createAuditEvent } from '@/features/security/audit';
import { originFromRequest } from '@/shared/changeOrigin';
import { logSecurityEvent } from '@/features/security/security';
import { fetchLoginUserById } from '@/features/identity/tirbeo';

export const runtime = 'nodejs';

const DELETION_WINDOW_DAYS = 30;

/**
 * DELETE ACCOUNT — Soft Delete Flow
 *
 * 1. User requests deletion → status becomes 'deletion_pending' + a
 *    UserDeletionRequest row records the final date (sessions revoked).
 * 2. After the window → permanent deletion (cron job, irreversible)
 * 3. During the window, the user can cancel (PATCH) → status back to 'active'.
 *
 * The consolidated schema no longer carries deletedAt/scheduledDeletionAt on
 * User: the lifecycle lives on `user.status` + `user_deletion_requests`.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    // Sensitive action — identity proof via the shared reauth guard
    // (passkey assertion, account password, or TOTP). Replaces the old
    // password-only check, which passwordless accounts could never pass.
    // The guard reads the body, so anything else it carries comes from there.
    const proof = await requireReauth(request, session.userId);
    if ('response' in proof) return proof.response;
    const { reason } = (proof.body ?? {}) as any;

    // Load the account (primary email comes from the LoginUser view) and its
    // current deletion request, if any.
    const existingUser = await fetchLoginUserById(session.userId);
    if (!existingUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const activeDeletion = await prisma.userDeletionRequest.findUnique({
      where: { userId: session.userId },
      select: { finalAt: true, cancelledAt: true },
    });

    if (existingUser.status === 'deletion_pending' && activeDeletion && !activeDeletion.cancelledAt) {
      return NextResponse.json({ error: 'Account is already scheduled for deletion' }, { status: 400 });
    }

    // ─── Step 1: Revoke all sessions immediately ───
    // user_sessions has no status column: a session is active while revokedAt
    // is null. Revocation is the revokedAt stamp.
    await prisma.userSession.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // ─── Step 2: Mark the account deletion_pending and schedule finalization ───
    logSecurityEvent({ request, userId: session.userId, eventType: 'security.deletion_scheduled', severity: 'warning', details: { reason: reason || 'user_requested', reauthMethod: proof.method } }).catch(() => {});
    const finalAt = new Date(Date.now() + DELETION_WINDOW_DAYS * 24 * 60 * 60 * 1000); // 30 days

    await prisma.user.update({
      where: { id: session.userId },
      data: { status: 'deletion_pending' },
    });

    await prisma.userDeletionRequest.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId, reason: reason || 'user_requested', finalAt },
      update: { reason: reason || 'user_requested', finalAt, cancelledAt: null, executedAt: null },
    });

    // Scrub security credentials immediately — TOTP secret / backup codes now
    // live on user_security rather than the user row.
    await prisma.userSecurity
      .updateMany({
        where: { userId: session.userId },
        data: { totpSecret: null, totpEnabled: false, backupCodes: [] },
      })
      .catch(() => {});

    // ─── Step 3: Delete critical user-owned rows ───
    // Cascade handles most relations, but delete the sensitive ones explicitly.
    const deleteOps = [
      prisma.apiKey.deleteMany({ where: { userId: session.userId } }),
      prisma.otp.deleteMany({ where: { userId: session.userId } }),
      prisma.passkey.deleteMany({ where: { userId: session.userId } }),
      prisma.notification.deleteMany({ where: { userId: session.userId } }),
    ];

    await Promise.allSettled(deleteOps);

    // ─── Step 4: Audit log (with the original email) ───
    await createAuditEvent({
      actorId: session.userId,
      action: 'user.soft_delete',
      targetType: 'user',
      targetId: session.userId,
      severity: 'warning',
      metadata: {
        email: existingUser.email,
        scheduledDeletionAt: finalAt.toISOString(),
        reason: reason || 'user_requested',
      },
      origin: originFromRequest(request.headers),
    }).catch(() => {});

    // ─── Step 5: Clear session cookie ───
    // Revoke ALL sessions for the user (every device, every app) and clear the
    // cookies for the SAME domain they were set on. Previously only __session
    // was cleared host-only, so __refresh/__csrf survived on .tirbeo.com and
    // the user stayed signed in on other subdomains after scheduling deletion.
    await revokeSessionFamilyByUser(session.userId).catch(() => {});
    const response = NextResponse.json({
      success: true,
      message: `Account scheduled for permanent deletion in ${DELETION_WINDOW_DAYS} days. Contact support@tirbeo.com to cancel.`,
      scheduledDeletionAt: finalAt.toISOString(),
    });

    const clearedCookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 0,
      domain: process.env.NEXT_PUBLIC_COOKIE_DOMAIN || undefined,
    };
    response.cookies.set('__session', '', clearedCookieOptions);
    response.cookies.set('__refresh', '', clearedCookieOptions);
    response.cookies.set('__csrf', '', { ...clearedCookieOptions, httpOnly: false });

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
      select: { status: true },
    });

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const dr = await prisma.userDeletionRequest.findUnique({
      where: { userId: session.userId },
      select: { finalAt: true, cancelledAt: true },
    });

    const scheduled = user.status === 'deletion_pending' && !!dr && !dr.cancelledAt;
    const finalAt = scheduled ? dr!.finalAt : null;

    return NextResponse.json({
      deleted: user.status === 'deleted' || scheduled,
      deletedAt: null,
      scheduledDeletionAt: finalAt ? finalAt.toISOString() : null,
      daysRemaining: finalAt
        ? Math.max(0, Math.ceil((finalAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
        : null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

/**
 * PATCH — Cancel deletion (within the window)
 */
export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Auth required' }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { status: true },
    });

    const dr = await prisma.userDeletionRequest.findUnique({
      where: { userId: session.userId },
      select: { finalAt: true, cancelledAt: true },
    });

    // Only a pending, un-cancelled request can be restored.
    if (user?.status !== 'deletion_pending' || !dr || dr.cancelledAt) {
      return NextResponse.json({ error: 'Account is not scheduled for deletion' }, { status: 400 });
    }

    // Can only cancel if within the window.
    if (dr.finalAt < new Date()) {
      return NextResponse.json({ error: 'Deletion window has passed' }, { status: 400 });
    }

    // Restore the user and mark the request cancelled.
    await prisma.user.update({
      where: { id: session.userId },
      data: { status: 'active' },
    });
    await prisma.userDeletionRequest.updateMany({
      where: { userId: session.userId },
      data: { cancelledAt: new Date() },
    });

    await createAuditEvent({
      actorId: session.userId,
      action: 'user.cancel_deletion',
      targetType: 'user',
      targetId: session.userId,
      metadata: { cancelledAt: new Date().toISOString() },
      origin: originFromRequest(request.headers),
    }).catch(() => {});
    logSecurityEvent({ request, userId: session.userId, eventType: 'security.deletion_cancelled' }).catch(() => {});

    return NextResponse.json({
      success: true,
      message: 'Deletion cancelled.',
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
