import { prisma } from '@/infrastructure/db/prisma';

/**
 * PERMANENT ACCOUNT DELETION — the sweep.
 *
 * Runs on the hourly deletion timer and from the admin panel. It is bounded
 * three ways so it can never destroy the wrong account:
 *
 *   1. Only requests whose `finalAt <= now` (the 30-day grace window is up).
 *   2. Only requests NOT cancelled and NOT already executed.
 *   3. A batch cap per run, so one sweep can't take the whole table.
 *
 * A cancelled request (the person changed their mind inside the window) is
 * never touched, and a request that isn't due yet is left for a later run.
 * After deleting we stamp `executedAt` so the account is never double-processed
 * (and so the "already handled" case is explicit, not incidental).
 *
 * The lifecycle lives on `user.status` + `user_deletion_requests`; the legacy
 * scheduledDeletionAt column is only a mirror and is not what the sweep reads.
 */

/** Hard cap on how many accounts one sweep run may permanently delete. */
export const DELETION_SWEEP_BATCH = 50;

/**
 * The pure sweep logic, with `now` injected so it can be tested against a
 * fixture without waiting 30 days. Returns how many accounts were deleted.
 */
export async function runDeletionSweep(now: Date = new Date(), limit = DELETION_SWEEP_BATCH): Promise<{ deleted: number }> {
  const due = await prisma.userDeletionRequest.findMany({
    where: {
      finalAt: { lte: now },
      cancelledAt: null,
      executedAt: null,
    },
    select: { userId: true },
    take: limit,
  });

  if (due.length === 0) return { deleted: 0 };

  console.log(`[PERMANENT-DELETION] Processing ${due.length} accounts for permanent deletion`);

  let deleted = 0;
  for (const req of due) {
    try {
      await permanentlyDeleteUser(req.userId, now);
      deleted++;
      console.log(`[PERMANENT-DELETION] Deleted user ${req.userId}`);
    } catch (err: any) {
      console.error(`[PERMANENT-DELETION] Failed to delete ${req.userId}:`, err?.message);
    }
  }

  return { deleted };
}

export async function permanentDeletionJob(): Promise<{ deleted: number }> {
  try {
    const result = await runDeletionSweep();
    if (result.deleted) console.log(`[PERMANENT-DELETION] Completed batch of ${result.deleted} deletions`);
    return result;
  } catch (err: any) {
    console.error('[PERMANENT-DELETION] Job failed:', err?.message);
    return { deleted: 0 };
  }
}

async function permanentlyDeleteUser(userId: string, now: Date) {
  // Resolve the primary email for the log line (user.email is now a user_email row)
  const primaryEmail = await prisma.userEmail
    .findFirst({ where: { userId, kind: 'primary' }, select: { address: true } })
    .catch(() => null);
  const email = primaryEmail?.address ?? '(unknown)';

  // Mark the request executed BEFORE removing the row (the row itself cascades
  // away with the user), so an interrupted run can never resurrect it and a
  // concurrent read sees it as handled.
  await prisma.userDeletionRequest
    .updateMany({ where: { userId, executedAt: null }, data: { executedAt: now } })
    .catch(() => {});

  // Delete all related data first (in order of FK dependencies).
  // securityEvent / auditEvent merged into activityEvent (which cascades on the
  // user row); the old `session` table became user_sessions.
  const deleteOps = [
    prisma.apiKey.deleteMany({ where: { userId } }),
    prisma.otp.deleteMany({ where: { userId } }),
    prisma.passkey.deleteMany({ where: { userId } }),
    prisma.notification.deleteMany({ where: { userId } }),
    prisma.userSession.deleteMany({ where: { userId } }),
  ];

  await Promise.allSettled(deleteOps);

  // Delete the user record itself — this is the point of no return.
  // Remaining rows (profile, preferences, emails, security, activity events,
  // deletion request, etc.) are removed by FK cascade.
  await prisma.user.delete({ where: { id: userId } });

  console.log(`[PERMANENT-DELETION] User ${userId} (${email}) permanently deleted. Data is unrecoverable.`);
}

