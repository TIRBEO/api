import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/infrastructure/db/prisma';
import { requirePermission } from '@/features/auth/http-guards';
import { banUser, unbanUser, suspendUser, unsuspendUser } from '@/features/admin/adminHandlers';
import { revokeSessionById } from '@/features/admin/devices';
import { unblockTarget } from '@/features/security/security';
import { markAsRead } from '@/features/notifications/notifications';
import { createAuditEvent } from '@/features/security/audit';
import { clientIpOrUnknown } from '@/shared/client-ip';

/* Acting on many rows at once.
 *
 * Every verb here calls the single-row handler that already exists, once per id.
 * That is the whole design and it is not laziness: a batch that reimplements the
 * change would be a second implementation of the rules — who may ban staff, what
 * gets written to the ledger, who gets mailed, which sessions die — and the two
 * would drift within a month, with the batch being the one that skips the audit
 * row because nobody remembered to copy it.
 *
 * The result is therefore a count and a list, never a single "ok". An operator
 * who selected two hundred accounts and got "done" for one hundred and sixty of
 * them is entitled to know which forty were not touched and why; a partial
 * reported as a success is a wrong number on a screen, and the console's rule
 * about those is stricter than most.
 *
 * Rows go one at a time. Each account suspension mails a person, writes an
 * enforcement row, a security event and an audit line, and fires the session
 * clear; two hundred of those in parallel is a spike against the pool and the
 * mail provider for no benefit to the operator, who is waiting either way.
 */

const MAX_BULK = 200;

export type BulkFailure = { id: string; reason: string };
export type BulkResult = {
  action: string;
  requested: number;
  done: number;
  failed: BulkFailure[];
  /** The sentence for a screen that has to say what happened without adding up
   *  the numbers itself. `partial` is the case an operator most needs named. */
  partial: boolean;
  message: string;
};

function summarize(action: string, requested: number, done: number, failed: BulkFailure[]): BulkResult {
  const partial = done > 0 && failed.length > 0;
  const message = failed.length === 0
    ? `${done} of ${requested} done.`
    : done === 0
      ? `Nothing was done. ${failed.length} ${failed.length === 1 ? 'row was' : 'rows were'} refused.`
      : `Partly done: ${failed.length} ${failed.length === 1 ? 'row was' : 'rows were'} not ${action}.`;
  return { action, requested, done, failed, partial, message };
}

const idsSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(MAX_BULK),
});

/** The body, read once. A `NextRequest` body is a stream: the first
 *  `.json()` call consumes it, so anything downstream that tries again gets a
 *  rejected promise rather than the payload. Every handler here reads through
 *  this and passes the value on, rather than re-reading. */
function jsonBody(request: NextRequest) {
  return request.json().catch(() => ({}));
}

/* ── Accounts ───────────────────────────────────────────────────────────── */

const USER_ACTIONS = {
  suspend: suspendUser,
  unsuspend: unsuspendUser,
  ban: banUser,
  unban: unbanUser,
} as const;

type UserAction = keyof typeof USER_ACTIONS;

const userSchema = z.object({
  action: z.enum(['suspend', 'unsuspend', 'ban', 'unban']),
  ids: z.array(z.string().trim().min(1)).min(1).max(MAX_BULK),
  reason: z.string().trim().max(500).optional(),
  days: z.number().int().min(1).max(365).optional(),
}).superRefine((value, ctx) => {
  // Checked once, here, rather than two hundred times by the row handler.
  // Lifting a sanction mails the account the sentence, so no code path accepts
  // an empty one — a batch without a reason would otherwise be N identical
  // refusals and an operator with no idea which line to fix.
  if ((value.action === 'unsuspend' || value.action === 'unban') && !value.reason?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['reason'],
      message: `Say why the ${value.action === 'unban' ? 'ban' : 'suspension'} is being lifted — the same sentence goes to every account in the set.`,
    });
  }
});

/** A clone of the incoming request aimed at one account.
 *
 *  The single-row handlers take a `NextRequest` because that is what an HTTP
 *  route hands them: they read the permission from its cookies and the IP for
 *  the audit row from its headers. Cloning keeps both true for every row — the
 *  operator who asked is the actor, from the address they came from — which a
 *  hand-built argument list would quietly lose. The body is rebuilt from the
 *  already-parsed values, because the batch's own body stream is spent. */
function rowRequest(request: NextRequest, id: string, action: UserAction, reason?: string, days?: number): NextRequest {
  const headers = new Headers(request.headers);
  // A stale content-length from the batch request would not match the one-row
  // payload, and the handler reading the body would be handed nothing.
  headers.delete('content-length');
  const body: Record<string, unknown> = {};
  if (reason?.trim()) body.reason = reason.trim();
  if (action === 'suspend' && Number.isFinite(days)) body.days = days;
  const url = new URL(request.url);
  url.pathname = `/api/admin/users/${encodeURIComponent(id)}/${action}`;
  return new NextRequest(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
}

export async function bulkUsers(request: NextRequest) {
  const session = await requirePermission(request, 'people.bulk');
  if (session instanceof NextResponse) return session;

  const parsed = userSchema.safeParse(await jsonBody(request));
  if (!parsed.success) {
    const why = parsed.error.issues.find((issue) => issue.path[0] === 'reason')?.message;
    return NextResponse.json({
      error: why || 'Give an action (suspend, unsuspend, ban, unban) and up to ' + MAX_BULK + ' account ids.',
    }, { status: 400 });
  }
  const { action, reason, days } = parsed.data;
  const ids = [...new Set(parsed.data.ids)];

  // Lifting a sanction in bulk is the one direction an operator should not be
  // able to point at a peer: unbanning every banned staff account is a way to
  // hand the console back to people somebody deliberately removed, and the
  // single-row path only refuses applying a sanction, not lifting one.
  if (action === 'unban' || action === 'unsuspend') {
    const staff = await prisma.user.count({ where: { id: { in: ids }, isAdmin: true } });
    if (staff && session.staff.role !== 'owner') {
      return NextResponse.json({
        error: `That set includes ${staff} staff account${staff === 1 ? '' : 's'}. Only an owner can lift a sanction from somebody who runs this platform.`,
      }, { status: 403 });
    }
  }

  const handler = USER_ACTIONS[action];
  const failed: BulkFailure[] = [];
  let done = 0;

  for (const id of ids) {
    if (id === session.userId) {
      failed.push({ id, reason: 'That is your own account. Sanction it from its own page, where you will have to mean it.' });
      continue;
    }
    try {
      const response = await handler(rowRequest(request, id, action, reason, days), id);
      if (response.status >= 400) {
        const body = await response.clone().json().catch(() => ({}) as Record<string, unknown>);
        failed.push({ id, reason: typeof body?.error === 'string' ? body.error : `Refused (${response.status}).` });
        continue;
      }
      done += 1;
    } catch (e: any) {
      failed.push({ id, reason: e?.message ? `Could not be recorded: ${e.message}` : 'Something in the database refused this one.' });
    }
  }

  const result = summarize(action, ids.length, done, failed);
  await createAuditEvent({
    actorId: session.userId,
    action: `admin.users_bulk_${action}`,
    // A batch that half worked is a warning whether or not the operator noticed.
    severity: failed.length ? 'warning' : 'info',
    targetType: 'user',
    metadata: {
      action,
      reason: reason ?? null,
      requested: ids.length,
      done,
      failedIds: failed.map((row) => row.id),
      actorEmail: session.email,
    },
    ip: clientIpOrUnknown(request.headers),
    userAgent: request.headers.get('user-agent'),
  });

  return NextResponse.json(result, { status: failed.length && !done ? 400 : 200 });
}

/* ── Sessions ───────────────────────────────────────────────────────────── */

export async function bulkSessions(request: NextRequest) {
  const session = await requirePermission(request, 'people.manage');
  if (session instanceof NextResponse) return session;

  const parsed = idsSchema.safeParse(await jsonBody(request));
  if (!parsed.success) {
    return NextResponse.json({ error: `Give up to ${MAX_BULK} session ids to end.` }, { status: 400 });
  }
  const ids = [...new Set(parsed.data.ids)];

  const failed: BulkFailure[] = [];
  let done = 0;
  for (const id of ids) {
    // `revokeSessionById` answers { ok, reason } and writes its own audit row,
    // which is exactly what a batch should be built on.
    const result = await revokeSessionById(id, { id: session.userId, email: session.email });
    if (result.ok) done += 1;
    else failed.push({ id, reason: result.reason === 'already_revoked' ? 'Already ended.' : result.reason === 'no_such_session' ? 'No such session.' : 'Could not be ended.' });
  }

  return NextResponse.json(summarize('sessions ended', ids.length, done, failed), {
    status: failed.length && !done ? 400 : 200,
  });
}

/* ── Blocklist ──────────────────────────────────────────────────────────── */

const blockSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(MAX_BULK),
  action: z.enum(['unblock']).default('unblock'),
});

export async function bulkBlocklist(request: NextRequest) {
  const session = await requirePermission(request, 'blocklist.manage');
  if (session instanceof NextResponse) return session;

  const parsed = blockSchema.safeParse(await jsonBody(request));
  if (!parsed.success) {
    return NextResponse.json({ error: `Give up to ${MAX_BULK} block ids to lift.` }, { status: 400 });
  }
  const ids = [...new Set(parsed.data.ids)];

  const rows = await prisma.blocklist.findMany({ where: { id: { in: ids } }, select: { id: true, targetType: true, targetId: true } });
  const found = new Map(rows.map((row) => [row.id, row]));

  const failed: BulkFailure[] = [];
  let done = 0;
  for (const id of ids) {
    const row = found.get(id);
    if (!row) {
      // Named before calling the primitive, because `unblockTarget` throws on a
      // missing row when no cache is configured — and "the row you selected is
      // gone" is the answer, not a stack trace.
      failed.push({ id, reason: 'No such entry — somebody else may have lifted it.' });
      continue;
    }
    try {
      await unblockTarget(row.targetType, row.targetId);
      done += 1;
    } catch (e: any) {
      failed.push({ id, reason: e?.message ? `Could not be lifted: ${e.message}` : 'Could not be lifted.' });
    }
  }

  if (done) {
    await createAuditEvent({
      actorId: session.userId,
      action: 'admin.blocklist_bulk_unblocked',
      severity: 'warning',
      targetType: 'blocklist',
      metadata: { requested: ids.length, done, failedIds: failed.map((row) => row.id), actorEmail: session.email },
      ip: clientIpOrUnknown(request.headers),
      userAgent: request.headers.get('user-agent'),
    });
  }

  return NextResponse.json(summarize('blocks lifted', ids.length, done, failed), {
    status: failed.length && !done ? 400 : 200,
  });
}

/* ── The operator's own notifications ───────────────────────────────────── */

export async function bulkNotifications(request: NextRequest) {
  const session = await requirePermission(request, 'notifications.read');
  if (session instanceof NextResponse) return session;

  const parsed = idsSchema.safeParse(await jsonBody(request));
  if (!parsed.success) {
    return NextResponse.json({ error: `Give up to ${MAX_BULK} notification ids.` }, { status: 400 });
  }
  const ids = [...new Set(parsed.data.ids)];

  // Scoped to the person asking, by the same rule the single-row PUT follows:
  // `markAsRead` will only ever touch the operator's own rows, so an id from
  // somebody else's inbox is reported as what it is rather than quietly skipped.
  const mine = await prisma.notification.findMany({
    where: { id: { in: ids }, userId: session.userId, isRead: { not: true } },
    select: { id: true },
  });
  const unread = new Set(mine.map((row) => row.id));

  const failed: BulkFailure[] = [];
  let done = 0;
  for (const id of ids) {
    if (!unread.has(id)) {
      failed.push({ id, reason: 'Not an unread notification of yours.' });
      continue;
    }
    await markAsRead(session.userId, id);
    done += 1;
  }

  return NextResponse.json(summarize('marked read', ids.length, done, failed), {
    status: failed.length && !done ? 400 : 200,
  });
}
