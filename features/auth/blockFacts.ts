import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { ensureRefCode } from '@/features/users/refcode';
import { activeDeletionFor } from '@/features/status/accountLifecycle';

/* ═══════════════════════════════════════════════════════════════════
   The single source of truth about a closed account.

   Two surfaces speak about a closed account: the sign-in routes, which let a
   matched credential in carrying the decision of record (plus a session that
   opens only the closure screen), and the settings gate, which renders it.
   Both read from here, so a ban cannot be described one way at the login
   form and another way in the settings screen.

   Nothing in this file is derived from a URL, a cookie or a query parameter.
   Facts about a decision — the reference code, the reason, the end date — come
   out of the row that records the decision. That is what makes them safe to
   show, and it is why the block hand-off no longer signs any of them into a
   redirect target: a link can carry an address, never a verdict.
   ═══════════════════════════════════════════════════════════════════ */

export type BlockKind = 'banned' | 'suspended' | 'deletion_pending' | 'deactivated' | 'deleted';

export type BlockFacts = {
  kind: BlockKind;
  eventId: string;
  /** The row behind a ban or suspension — what an appeal is filed against. */
  decisionId: string | null;
  reason: string | null;
  until: string | null;
  message: string;
};

/** Wire shape per kind: the machine-readable error, the legacy boolean flag
 *  clients already branch on, and the human sentence. */
const SHAPE: Record<BlockKind, { error: string; flag: string; message: string; ref: 'ban' | 'suspend' | 'delete' | 'deactivate' | 'deleted' }> = {
  banned: { error: 'ACCOUNT_BANNED', flag: 'banned', message: 'Your account has been banned.', ref: 'ban' },
  suspended: { error: 'ACCOUNT_SUSPENDED', flag: 'suspended', message: 'Your account is temporarily suspended.', ref: 'suspend' },
  deletion_pending: { error: 'ACCOUNT_DELETION_PENDING', flag: 'deletionPending', message: 'Your account is scheduled for deletion. You can still cancel it.', ref: 'delete' },
  deactivated: { error: 'ACCOUNT_DEACTIVATED', flag: 'deactivated', message: 'Your account is paused. You can reactivate it any time.', ref: 'deactivate' },
  deleted: { error: 'ACCOUNT_DELETED', flag: 'deleted', message: 'Your account has been deleted.', ref: 'deleted' },
};

/** Statuses that make a sign-in an interrupted one — the person gets in, but
 *  the settings gate is what they see first. Kept beside the shape itself so
 *  a caller gating "is this user closed?" and the payload it returns cannot
 *  drift. */
export function isBlockedSignInStatus(status: string | null | undefined): boolean {
  return !!status && Object.hasOwn(SHAPE, status);
}

/** The machine-readable half of the refusal for a kind: the error code clients
 *  branch on plus the legacy boolean flag. Exported so a caller that has the
 *  facts but builds its own response body cannot invent a third spelling. */
export function blockWireFields(kind: BlockKind): { error: string; flag: string } {
  return { error: SHAPE[kind].error, flag: SHAPE[kind].flag };
}

/** One spelling of the answer on the wire, shared by the sign-in that hands it
 *  out and every later door that refuses with it. */
function blockBody(facts: BlockFacts) {
  const { error, flag } = SHAPE[facts.kind];
  return { error, [flag]: true, blocked: true, ...facts };
}

/** The most recent NON-EXPIRED restriction on the account — the live decision
 *  behind a banned/suspended block. An open-ended row (endsAt null) never
 *  expires; a dated row is live until its endsAt passes. Best-effort: the block
 *  answer must not fail because the detail read did — reason and until read
 *  null rather than turning a 403 the person can act on into a 500. */
async function activeRestrictionFor(userId: string): Promise<{ id: string; title: string; detail: string | null; endsAt: Date | null } | null> {
  try {
    const r = await prisma.userRestriction.findFirst({
      where: { userId, OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
      orderBy: { startedAt: 'desc' },
      select: { id: true, title: true, detail: true, endsAt: true } });
    return r ?? null;
  } catch {
    return null;
  }
}

/** Read the decision of record for a closed account. Returns null for a status
 *  that is not a closure, so a caller cannot accidentally "block" an active
 *  account. Every read degrades to a missing detail, never to a failed refusal. */
export async function blockFactsFor(userId: string, status: string | null | undefined): Promise<BlockFacts | null> {
  if (!isBlockedSignInStatus(status)) return null;
  const kind = status as BlockKind;
  const shape = SHAPE[kind];
  let reason: string | null = null;
  let until: string | null = null;
  let decisionId: string | null = null;

  if (kind === 'banned' || kind === 'suspended') {
    const restriction = await activeRestrictionFor(userId);
    decisionId = restriction?.id ?? null;
    reason = restriction ? (restriction.detail || restriction.title) : null;
    until = restriction?.endsAt ? restriction.endsAt.toISOString() : null;
  } else if (kind === 'deletion_pending') {
    const [active, dr] = await Promise.all([
      activeDeletionFor(userId),
      prisma.userDeletionRequest.findUnique({ where: { userId }, select: { reason: true } }).catch(() => null),
    ]);
    reason = dr?.reason ?? null;
    until = active?.finalAt ? active.finalAt.toISOString() : null;
  } else if (kind === 'deactivated') {
    const deactivation = await prisma.userDeactivation.findUnique({ where: { userId }, select: { reason: true } }).catch(() => null);
    reason = deactivation?.reason ?? null;
  }

  // A lost reference table must not swallow the refusal: ensureRefCode falls
  // back to a deterministic code derived from the user id.
  const eventId = await ensureRefCode(userId, shape.ref).catch(() => '');
  return { kind, eventId, decisionId, reason, until, message: shape.message };
}

/** The answer to a closed account that has just proved it owns itself.
 *
 *  Call this ONLY after the person has presented a credential that matches the
 *  account — a verified password, a validated code, a consumed magic-link JWT,
 *  or a verified passkey assertion. An email address is not one of those.
 *
 *  When the request that proved the credentials is handed in, the answer is a
 *  session rather than a refusal. The settings app is where a closed account
 *  sees what happened and what can be undone, and it can only render that for a
 *  signed-in reader — so the person is let in, carrying a key that opens one
 *  room: the account-state read. Every other door is refused at the edge by the
 *  status gate, so the session grants nothing and reveals no data; it exists to
 *  let the account look at itself. Without a request (an admin console sign-in,
 *  where the person is stopped before the panel, not shown a settings page) the
 *  old 403 stands. */
export async function blockedAccountResponse(
  user: { id: string; status: string | null | undefined; email?: string | null; isAdmin?: boolean },
  request?: NextRequest,
): Promise<NextResponse> {
  const facts = await blockFactsFor(user.id, user.status);
  if (!facts) {
    return NextResponse.json({ error: 'ACCOUNT_UNAVAILABLE', message: 'This account is not available.' }, { status: 403 });
  }
  const body = blockBody(facts);

  if (request) {
    try {
      const { createSession, setSessionCookie } = await import('@/features/auth/session');
      const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
        || request.headers.get('x-real-ip') || 'unknown';
      const userAgent = request.headers.get('user-agent') || undefined;
      const { token, refreshToken, saveLoginInfo } = await createSession(
        user.id, userAgent, ip, user.isAdmin ? 'admin' : undefined,
      );
      const res = NextResponse.json(
        { id: user.id, email: user.email ?? null, token, ...body },
        { status: 200 },
      );
      setSessionCookie(res, token, refreshToken, request, { shortSession: !saveLoginInfo });
      return res;
    } catch {
      /* a session could not be minted — fall through to the plain refusal so the
         person still gets the decision of record rather than a 500 */
    }
  }

  return NextResponse.json(body, { status: 403 });
}

/* ── The session's doors ───────────────────────────────────────────
   The sign-in above hands a closed account a session that opens one room.
   That room is defined here, once: the edge asks this before the route
   handler runs, for a cookie session and a Bearer token alike, so no route
   — including the ones that live outside the dispatcher — has to remember
   to check. A refusal carries the same decision of record the login form
   handed out, so a door and the settings screen cannot disagree.
   ═══════════════════════════════════════════════════════════════════ */

/** The doors every closed account keeps, whatever the closure: the read that
 *  feeds the settings screen, the appeal, and signing out. */
const CLOSED_ACCOUNT_DOORS = ['/api/user/account-state', '/api/support/appeal'];

/** A pause and a scheduled deletion are the person's own doing, so the session
 *  stays read-only and keeps the one write that undoes it. A ban, a suspension
 *  and a deletion that already ran are decisions the account cannot undo, so
 *  nothing beyond CLOSED_ACCOUNT_DOORS is open. */
const UNDO_DOOR: Partial<Record<BlockKind, { method: string; path: string }>> = {
  deletion_pending: { method: 'DELETE', path: '/api/user/delete-account' },
  deactivated: { method: 'POST', path: '/api/user/reactivate' },
};

export function isClosedAccountDoor(kind: BlockKind, pathname: string, method: string): boolean {
  if (CLOSED_ACCOUNT_DOORS.some((door) => pathname.startsWith(door))) return true;
  const undo = UNDO_DOOR[kind];
  if (undo && method === undo.method && pathname === undo.path) return true;
  if (kind !== 'deletion_pending' && kind !== 'deactivated') return false;
  return method === 'GET' || method === 'HEAD';
}

/** A dated ban or suspension has already run out; the status row just hasn't
 *  been told. Lifted on the first request that meets it, so an expired
 *  decision does not outlive itself. An undated restriction, or no
 *  restriction row at all, is open-ended and stays closed. */
async function liftExpiredClosure(userId: string): Promise<boolean> {
  const latest = await prisma.userRestriction
    .findFirst({ where: { userId }, orderBy: { startedAt: 'desc' }, select: { endsAt: true } })
    .catch(() => null);
  if (!latest?.endsAt || latest.endsAt > new Date()) return false;
  await prisma.user.update({ where: { id: userId }, data: { status: 'active' } }).catch(() => {});
  return true;
}

/** null means "let this request through". The body is handed back rather than
 *  wrapped, so the caller can answer it with its own CORS headers — a 403 a
 *  browser cannot read is a network error to the screen that needs it. */
export async function closedAccountBody(
  userId: string,
  status: string | null | undefined,
  pathname: string,
  method: string,
): Promise<Record<string, unknown> | null> {
  if (!isBlockedSignInStatus(status)) return null;
  const kind = status as BlockKind;
  if (isClosedAccountDoor(kind, pathname, method)) return null;
  if ((kind === 'banned' || kind === 'suspended') && await liftExpiredClosure(userId)) return null;
  const facts = await blockFactsFor(userId, kind);
  return facts ? blockBody(facts) : null;
}

/* The status decides the whole gate, so one read serves a whole minute of
   requests for that account instead of a lookup per call. Shared by the edge
   and the dispatcher so the two ask the same account the same question. */
const STATUS_TTL = 60_000;
const statusCache = new Map<string, { status: string | null; ts: number }>();

export async function cachedUserStatus(userId: string): Promise<string | null> {
  const hit = statusCache.get(userId);
  if (hit && Date.now() - hit.ts < STATUS_TTL) return hit.status;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    const status = user?.status ?? null;
    statusCache.set(userId, { status, ts: Date.now() });
    if (statusCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of statusCache) { if (now - v.ts >= STATUS_TTL) statusCache.delete(k); }
    }
    return status;
  } catch {
    // A lookup that did not answer must not close an open account — nor, once
    // it is known the account IS closed, must it open a closed one.
    return hit?.status ?? null;
  }
}

/** The one question every door asks: may this session reach this path? */
export async function closedAccountGate(
  userId: string | null | undefined,
  pathname: string,
  method: string,
): Promise<Record<string, unknown> | null> {
  if (!userId) return null;
  return closedAccountBody(userId, await cachedUserStatus(userId), pathname, method);
}
