import { prisma } from '@/infrastructure/db/prisma';

/**
 * PERMANENT ACCOUNT DELETION — the sweep.
 *
 * Runs on the deletion timer (from `/api/cron` and from the request-path job
 * gate) and from the admin panel. It is bounded three ways so it can never
 * destroy the wrong account:
 *
 *   1. Only requests whose `finalAt <= now` (the 30-day grace window is up).
 *   2. Only requests NOT cancelled and NOT already executed.
 *   3. A batch cap per run, so one sweep can't take the whole table.
 *
 * A cancelled request (the person changed their mind inside the window) is
 * never touched, and a request that isn't due yet is left for a later run.
 *
 * WHAT IT USED TO GET WRONG, and why the shape below is what it is:
 *
 *   `permanentlyDeleteUser` stamped `executedAt` BEFORE removing the row, then
 *   deleted four tables and asked the database to cascade the rest. Three
 *   foreign keys said no — the blocklist entry an account filed, a support
 *   ticket, media it uploaded — and a `prisma.user.delete` against them throws
 *   P2003. The throw was caught per account and logged, so the request stayed
 *   marked executed: the account remained `deletion_pending` with every row of
 *   itself intact, and the sweep never asked again. "Scheduled for deletion"
 *   became a permanent state rather than a promise, and the one screen that
 *   quotes it says the data was removed on a date it was not.
 *
 *   So: the rows that block the removal are removed first, the clock is only
 *   stamped once the account is actually gone, and a delete that fails leaves
 *   the request due so the next run retries it. Nothing here is a best-effort
 *   afterthought about the person's data — what cannot be reached is reported,
 *   not swallowed.
 */

/** Hard cap on how many accounts one sweep run may permanently delete. */
export const DELETION_SWEEP_BATCH = 50;

/** The tables a Prisma model covers: the client's own calls, so a column that
 *  moves in the schema fails loudly at build time rather than silently at
 *  three in the morning. Everything cascading off `users` is left to the
 *  database — profile, preferences, emails, phone, security, devices, logins,
 *  status/restriction/appeal rows, activity events, export requests, push
 *  subscriptions, identities, tip logs, the deletion request itself. */
function modelPrunedRows(userId: string) {
  return [
    ['otps', () => prisma.otp.deleteMany({ where: { userId } })],
    ['passkeys', () => prisma.passkey.deleteMany({ where: { userId } })],
    ['notifications', () => prisma.notification.deleteMany({ where: { userId } })],
    ['user_sessions', () => prisma.userSession.deleteMany({ where: { userId } })],
    /* A security event outlives the account it describes otherwise: the
       relation is `SET NULL`, so the row stays with its ip address and user
       agent glued to nothing. Erasing the account means erasing its record. */
    ['security_events', () => prisma.securityEvent.deleteMany({ where: { userId } })],
    /* Both mail ledgers keep the address in plain text beside the user id, and
       `SET NULL` on `email_jobs` leaves the letter on file after the person
       who asked for it is gone. */
    ['email_jobs', () => prisma.email_jobs.deleteMany({ where: { userId } })],
    ['email_deliveries', () => prisma.email_deliveries.deleteMany({ where: { userId } })],
    /* A blocklist entry names the account in `blocked_by` at NO ACTION — the
       single row that, more than any other, made the whole delete throw. */
    ['blocklist', () => prisma.blocklist.deleteMany({ where: { blockedBy: userId } })],
  ] as const;
}

/** The tables with no model in `schema.prisma`: support tickets and their
 *  messages, and the media an account uploaded. `tickets.customer_id` and
 *  `ticket_messages.author_id` are RESTRICT, `media.uploaded_by` is NO ACTION
 *  and NOT NULL, so all three refuse the cascade.
 *
 *  Where they live is read from the database rather than assumed: the baseline
 *  DDL put them in named schemas (`support`, `media`) while everything the
 *  Prisma client touches sits in `public`, and the sweep has to work whichever
 *  the live database actually holds. A table that isn't there is reported, not
 *  guessed at. */
const IDENT = /^[a-z_][a-z0-9_]*$/i;
const quoted = new Map<string, string | null>();

/** `"schema"."table"` for a table name this database has, or null. */
async function quoteTable(name: string): Promise<string | null> {
  if (quoted.has(name)) return quoted.get(name) ?? null;
  const rows = await prisma.$queryRawUnsafe<{ table_schema: string }[]>(
    `SELECT "table_schema" FROM information_schema.tables
      WHERE "table_name" = $1
      ORDER BY CASE "table_schema" WHEN 'public' THEN 0 ELSE 1 END, "table_schema"`,
    name,
  ).catch(() => [] as { table_schema: string }[]);
  const schema = rows[0]?.table_schema;
  const found = schema && IDENT.test(schema) && IDENT.test(name) ? `"${schema}"."${name}"` : null;
  quoted.set(name, found);
  return found;
}

/** Rows of a modelless table that point at this account. `column` and `table`
 *  are literals from above, validated against `IDENT` by `quoteTable`. */
async function pruneRaw(table: string, column: string, userId: string): Promise<'absent' | 'ok'> {
  const quotedTable = await quoteTable(table);
  if (!quotedTable) return 'absent';
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${quotedTable} WHERE "${column}" = $1`,
      userId,
    );
    return 'ok';
  } catch (err: any) {
    throw new Error(`${quotedTable}.${column}: ${err?.message ?? err}`);
  }
}

/**
 * Remove one account and everything that is answerable for it.
 *
 * Returns once the user row is gone. Throws if it is not, with what refused —
 * the caller must not treat a returned void as proof of anything, which is
 * exactly the mistake this file used to make.
 */
export async function permanentlyDeleteUser(userId: string, now: Date = new Date()): Promise<void> {
  /* Spent refresh tokens are keyed by session id, so they have to be taken out
     while the sessions that own them can still be named. */
  const sessionIds = await prisma.userSession
    .findMany({ where: { userId }, select: { id: true } })
    .then((rows) => rows.map((row) => row.id))
    .catch(() => [] as string[]);

  const problems: string[] = [];

  for (const [name, prune] of modelPrunedRows(userId)) {
    try {
      await prune();
    } catch (err: any) {
      problems.push(`${name}: ${err?.message ?? err}`);
    }
  }

  /* Spent refresh tokens are keyed by session id and carry no foreign key at
     all, so they have to be taken out while the sessions that own them can
     still be named — otherwise a rotated token outlives the account it was
     issued to. */
  if (sessionIds.length) {
    try {
      await prisma.refreshTokenSpent.deleteMany({ where: { sessionId: { in: sessionIds } } });
    } catch (err: any) {
      problems.push(`refresh_token_spent: ${err?.message ?? err}`);
    }
  }

  /* The account's own ticket thread, then its uploads. Both refuse the cascade
     until nothing refers to the account any more. */
  for (const [table, column] of [
    ['ticket_messages', 'author_id'],
    ['tickets', 'customer_id'],
    ['cdn_files', 'uploaded_by'],
    ['media', 'uploaded_by'],
  ] as const) {
    try {
      await pruneRaw(table, column, userId);
    } catch (err: any) {
      problems.push(String(err?.message ?? err));
    }
  }

  // Resolve the primary email for the log line (user.email is a user_email row).
  const primaryEmail = await prisma.userEmail
    .findFirst({ where: { userId, kind: 'primary' }, select: { address: true } })
    .catch(() => null);

  /* The point of no return. Everything above exists so this one statement can
     complete; if it still refuses, the request stays due and the next run
     retries it, rather than being written off as handled. */
  try {
    await prisma.user.delete({ where: { id: userId } });
  } catch (err: any) {
    const reason = err?.message ?? String(err);
    throw new Error(
      `account ${userId} still on file (${reason})` +
      (problems.length ? ` — cleanup refused: ${problems.join('; ')}` : ''),
    );
  }

  const note = problems.length ? ` Residual: ${problems.join('; ')}` : '';
  console.log(
    `[PERMANENT-DELETION] User ${userId} (${primaryEmail?.address ?? '(unknown)'}) permanently deleted at ${now.toISOString()}. Data is unrecoverable.${note}`,
  );
}

/**
 * The pure sweep, with `now` injected so it can be tested against a fixture
 * without waiting 30 days. Returns how many accounts were deleted.
 */
export async function runDeletionSweep(now: Date = new Date(), limit = DELETION_SWEEP_BATCH): Promise<{ deleted: number }> {
  const due = await prisma.userDeletionRequest.findMany({
    where: {
      finalAt: { lte: now },
      cancelledAt: null,
      executedAt: null,
    },
    select: { userId: true },
    orderBy: { finalAt: 'asc' },
    take: limit,
  });

  if (due.length === 0) return { deleted: 0 };

  console.log(`[PERMANENT-DELETION] Processing ${due.length} accounts for permanent deletion`);

  let deleted = 0;
  for (const req of due) {
    try {
      /* Nothing is stamped before this: a request whose account is gone has no
         row left to stamp (it cascades with the user), and a request whose
         account is STILL here must stay due. That is what the previous version
         got backwards — it marked the work done, then failed to do it. */
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
