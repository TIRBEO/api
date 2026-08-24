import { prisma } from './db/prisma';
import { createAuditEvent } from './audit';

/**
 * PERMANENT ACCOUNT DELETION
 *
 * Runs daily. Finds users where:
 *   - deletedAt is set (soft-deleted)
 *   - scheduledDeletionAt <= now (30-day window passed)
 *
 * Then permanently deletes ALL their data. This is irreversible.
 * Even admins cannot recover the account after this.
 */
export async function permanentDeletionJob() {
  try {
    // Find users whose 30-day window has passed
    const expiredUsers = await prisma.user.findMany({
      where: {
        deletedAt: { not: null },
        scheduledDeletionAt: { not: null, lte: new Date() },
      },
      select: { id: true, email: true },
      take: 50, // Process in batches
    });

    if (expiredUsers.length === 0) return;

    console.log(`[PERMANENT-DELETION] Processing ${expiredUsers.length} accounts for permanent deletion`);

    for (const user of expiredUsers) {
      try {
        await permanentlyDeleteUser(user.id, user.email);
        console.log(`[PERMANENT-DELETION] Deleted user ${user.id}`);
      } catch (err: any) {
        console.error(`[PERMANENT-DELETION] Failed to delete ${user.id}:`, err?.message);
      }
    }

    console.log(`[PERMANENT-DELETION] Completed batch of ${expiredUsers.length} deletions`);
  } catch (err: any) {
    console.error('[PERMANENT-DELETION] Job failed:', err?.message);
  }
}

async function permanentlyDeleteUser(userId: string, email: string) {
  // Delete all related data first (in order of FK dependencies)
  const deleteOps = [
    prisma.apiKey.deleteMany({ where: { userId } }),
    prisma.otp.deleteMany({ where: { userId } }),
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.passkey.deleteMany({ where: { userId } }),
    prisma.passkeyChallenge.deleteMany({ where: { userId } }),
    prisma.notification.deleteMany({ where: { userId } }),
    prisma.notificationPreference.deleteMany({ where: { userId } }),
    prisma.pushSubscription.deleteMany({ where: { userId } }),
    prisma.securityEvent.deleteMany({ where: { userId } }),
    prisma.auditEvent.deleteMany({ where: { actorId: userId } }),
    prisma.integration.deleteMany({ where: { userId } }),
    prisma.media.deleteMany({ where: { uploadedBy: userId } }),
    prisma.userRole.deleteMany({ where: { userId } }),
    prisma.login_history.deleteMany({ where: { userId } }),
    prisma.ticket.deleteMany({ where: { customerId: userId } }),
    prisma.ticketMessage.deleteMany({ where: { authorId: userId } }),
    prisma.session.deleteMany({ where: { userId } }),
    prisma.oAuthConsent.deleteMany({ where: { userId } }),
    prisma.authorization_codes.deleteMany({ where: { userId } }),
    prisma.access_tokens.deleteMany({ where: { userId } }),
    prisma.refresh_tokens.deleteMany({ where: { userId } }),
  ];

  await Promise.allSettled(deleteOps);

  // Delete the user record itself — this is the point of no return
  await prisma.user.delete({ where: { id: userId } });

  console.log(`[PERMANENT-DELETION] User ${userId} (${email}) permanently deleted. Data is unrecoverable.`);
}
