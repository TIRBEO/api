import { prisma } from '@/infrastructure/db/prisma';
import { generateOtpCode } from '@/features/auth/otp';
import { hashOtpCode, verifyOtpCode as verifyOtpHash } from '@/features/auth/password';
import { enforceResendCooldown } from '@/features/auth/resend-cooldown';
import { addMinutes } from 'date-fns';
import { forgetUserStatus } from '@/features/auth/user-status-cache';

/**
 * Account lifecycle — the three things a person can do to their own account
 * that change whether they can sign in at all:
 *
 *   • Connected apps (OAuth links) — what "Connected apps" is made of.
 *   • Deactivation — a soft door: the account pauses, sign-in is refused, a
 *     real route brings it back.
 *   • Deletion — two steps (acknowledge, then a code to the sign-in email)
 *     into a 30-day window the sweep can cancel or execute.
 *
 * Everything here is a function over `prisma` plus the OTP primitives so the
 * handlers and the sweep share one source of truth. There is deliberately no
 * NextRequest/NextResponse in this file: keeping it dependency-light is what
 * lets the tests drive the whole lifecycle without a running server.
 */

// ═══════════════════════════════════════════════════════════════════
// SIGN-IN METHODS + OAUTH LINKS
// ═══════════════════════════════════════════════════════════════════

export type ProviderKey = 'google' | 'github' | 'discord';

export const PROVIDER_KEYS: ProviderKey[] = ['google', 'github', 'discord'];
export const PROVIDER_NAMES: Record<ProviderKey, string> = {
  google: 'Google',
  github: 'GitHub',
  discord: 'Discord',
};

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === 'string' && (PROVIDER_KEYS as string[]).includes(value);
}

/**
 * OAuth provider ids have exactly one home: `preferences.misc.oauth`
 * ({ [provider]: providerId }). The old googleId/githubId/discordId columns
 * were dropped, so this map is both the read and the write store.
 */
async function readMisc(userId: string): Promise<Record<string, any>> {
  const p = await prisma.userPreferences.findUnique({ where: { userId }, select: { misc: true } }).catch(() => null);
  return ((p?.misc as any) || {});
}

export async function readOauthLinks(userId: string): Promise<Record<string, string>> {
  const misc = await readMisc(userId);
  return (misc.oauth as Record<string, string>) || {};
}

export async function writeOauthLink(userId: string, provider: ProviderKey, providerId: string): Promise<void> {
  const misc = { ...(await readMisc(userId)) };
  misc.oauth = { ...(misc.oauth || {}), [provider]: providerId };
  await prisma.userPreferences.upsert({
    where: { userId },
    update: { misc },
    create: { userId, misc },
  }).catch(() => {});
}

export async function clearOauthLink(userId: string, provider: ProviderKey): Promise<void> {
  const misc = { ...(await readMisc(userId)) };
  if (misc.oauth) {
    const nextOauth = { ...misc.oauth };
    delete nextOauth[provider];
    misc.oauth = nextOauth;
  }
  await prisma.userPreferences.upsert({
    where: { userId },
    update: { misc },
    create: { userId, misc },
  }).catch(() => {});
}

/** The link map: preferences.misc.oauth is the only store. */
export async function effectiveLinks(userId: string): Promise<Record<string, string>> {
  return readOauthLinks(userId);
}

/** An open-ended row (endsAt null) never expires; a dated row is live until its
    endsAt passes. Owned here because both the sign-in refusal and the settings
    read need the same row, and two predicates drift apart. */
export type RestrictionRow = { id: string; title: string; detail: string | null; endsAt: Date | null };

export async function liveRestrictionRow(userId: string): Promise<RestrictionRow | null> {
  const r = await prisma.userRestriction.findFirst({
    where: { userId, OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
    orderBy: { startedAt: 'desc' },
    select: { id: true, title: true, detail: true, endsAt: true },
  });
  return r ?? null;
}

export type ProviderLoginRow = { method: string; createdAt: Date };

function providerLoginRows(userId: string): Promise<ProviderLoginRow[]> {
  return prisma.userLogin
    .findMany({
      where: { userId, success: true, method: { in: PROVIDER_KEYS } },
      orderBy: { createdAt: 'asc' },
      select: { method: true, createdAt: true },
    })
    .catch(() => [] as ProviderLoginRow[]);
}

/** When each provider first appeared in the account's own record: the oldest
    `oauth.<provider>.connected` event, or the oldest `account.merge` row naming
    that provider. One read for all three.

    The loop version asked twice per provider, serially, and one of those asks
    filtered on a JSON path — six round trips through the pooler, on the path
    the settings gate renders nothing until it has answered. */
const LINK_EVENT_KINDS = PROVIDER_KEYS.map((p) => `oauth.${p}.connected`);

async function linkEventDates(userId: string): Promise<Record<string, string>> {
  const rows = await prisma.activityEvent
    .findMany({
      where: { userId, OR: [{ kind: { in: LINK_EVENT_KINDS } }, { kind: 'account.merge' }] },
      orderBy: { createdAt: 'asc' },
      // Oldest first, and the answer wanted is the first hit per provider, so
      // the head of the list is the useful part. A provider linked after the
      // first 100 such events falls back to the login ledger below.
      take: 100,
      select: { kind: true, metadata: true, createdAt: true },
    })
    .catch(() => [] as { kind: string; metadata: unknown; createdAt: Date }[]);

  const out: Record<string, string> = {};
  for (const row of rows) {
    const provider = row.kind.startsWith('oauth.')
      ? row.kind.split('.')[1]
      : String(((row.metadata as Record<string, unknown> | null)?.provider ?? '') as string);
    if (!isProviderKey(provider) || out[provider]) continue;
    out[provider] = row.createdAt.toISOString();
  }
  return out;
}

export interface ConnectionRow {
  id: string;
  provider: string;
  connected: boolean;
  accountId: string | null;
  linkedAt: string | null;
  firstNameUsedAt: string | null;
  lastUsedAt: string | null;
}

/** The rows, from reads the caller already has. A link with no event of its
    own shows the first sign-in through that provider, which is the oldest date
    the account can actually prove. */
function connectionRows(
  userId: string,
  links: Record<string, string>,
  logins: ProviderLoginRow[],
  linkedAt: Record<string, string>,
): ConnectionRow[] {
  return PROVIDER_KEYS.map((provider) => {
    const used = logins.filter((row) => row.method === provider);
    const accountId = links[provider] ?? null;
    return {
      id: `${userId}:${provider}`,
      provider,
      connected: !!accountId,
      accountId,
      linkedAt: accountId ? (linkedAt[provider] ?? (used.length ? used[0].createdAt.toISOString() : null)) : null,
      firstNameUsedAt: used.length ? used[0].createdAt.toISOString() : null,
      lastUsedAt: used.length ? used[used.length - 1].createdAt.toISOString() : null,
    };
  });
}

export type ConnectionsPreload = {
  links?: Record<string, string>;
  logins?: ProviderLoginRow[];
  linkedAt?: Record<string, string>;
};

export async function listConnections(userId: string, preloaded?: ConnectionsPreload): Promise<ConnectionRow[]> {
  const [links, logins, linkedAt] = await Promise.all([
    preloaded?.links ?? effectiveLinks(userId),
    preloaded?.logins ?? providerLoginRows(userId),
    preloaded?.linkedAt ?? linkEventDates(userId),
  ]);
  return connectionRows(userId, links, logins, linkedAt);
}

export interface SignInMethods {
  password: boolean;
  passkey: boolean;
  oauth: ProviderKey[];
  total: number;
}

/**
 * Count of ways the account can actually get in. Password counts only when a
 * hash exists (the column defaults to ''). Passkeys and OAuth links count as
 * sign-in methods in their own right — a passwordless account that unlinks its
 * only provider must be refused, exactly like a passwordless account with one
 * passkey that tries to delete the passkey.
 */
export async function signInMethods(
  userId: string,
  preloaded?: { links?: Record<string, string>; passwordHash?: string | null; passkeyCount?: number },
): Promise<SignInMethods> {
  const [user, linkMap, passkeyCount] = await Promise.all([
    preloaded?.passwordHash !== undefined ? { passwordHash: preloaded.passwordHash }
      : prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }).catch(() => null),
    preloaded?.links ?? effectiveLinks(userId),
    preloaded?.passkeyCount ?? prisma.passkey.count({ where: { userId } }).catch(() => 0),
  ]);
  const oauth = Object.keys(linkMap).filter(isProviderKey) as ProviderKey[];
  const password = !!user?.passwordHash;
  const passkey = passkeyCount > 0;
  const total = (password ? 1 : 0) + (passkey ? 1 : 0) + oauth.length;
  return { password, passkey, oauth, total };
}

/**
 * Remove one OAuth link, refusing to leave the account with no way in. Both
 * disconnect paths (the settings screen and the admin-side unlink) go through
 * here so the guard can't be missed by one of them. The guard counts the UNION
 * of link stores plus passkeys — not just the legacy columns.
 *
 * Returns nothing on success, or the refusal the caller should answer with.
 */
export async function unlinkProvider(
  userId: string,
  provider: ProviderKey,
): Promise<{ status: number; error: string } | null> {
  const linkMap = await effectiveLinks(userId);
  if (!linkMap[provider]) return { status: 400, error: 'That app is not connected' };

  // Would there be any way left after this link is gone?
  const remainingOAuth = Object.keys(linkMap).filter((p) => p !== provider).length;
  const [methods] = await Promise.all([signInMethods(userId)]);
  const otherWays = (methods.password ? 1 : 0) + (methods.passkey ? 1 : 0) + remainingOAuth;
  if (otherWays === 0) {
    return { status: 400, error: 'You must keep at least one sign-in method' };
  }

  await clearOauthLink(userId, provider);
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// DEACTIVATION (soft door)
// ═══════════════════════════════════════════════════════════════════

/**
 * Put the account in a distinct paused state. The current session is kept alive
 * (so the person reaches the "deactivated" screen and can undo it right there);
 * every OTHER session is revoked. `status='deactivated'` is what makes sign-in
 * refuse — see the change described for authHandlers.loginHandler.
 */
export async function deactivateAccount(userId: string, opts: { keepSessionId?: string | null; reason?: string | null } = {}) {
  const current = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!current) throw new Error('User not found');

  await prisma.user.update({ where: { id: userId }, data: { status: 'deactivated' } });
  forgetUserStatus(userId);

  await prisma.userDeactivation.upsert({
    where: { userId },
    create: { userId, reason: opts.reason ?? null, pausedAt: new Date(), resumedAt: null },
    update: { reason: opts.reason ?? null, pausedAt: new Date(), resumedAt: null },
  });

  await prisma.userStatusEvent.create({
    data: { userId, fromStatus: current.status, toStatus: 'deactivated', reason: opts.reason ?? 'user_deactivated', actor: 'user', metadata: {} },
  }).catch(() => {});

  // Revoke every session except the one making the request.
  await revokeOtherSessions(userId, opts.keepSessionId ?? null);

  await prisma.activityEvent.create({
    data: { userId, kind: 'account.deactivated', title: 'Account deactivated', detail: opts.reason ?? null, metadata: { targetType: 'user' }, severity: 'warning' },
  }).catch(() => {});

  return { status: 'deactivated' as const };
}

/**
 * Bring the account back. Clears the deactivation (resumedAt) and returns the
 * status to active. Safe to call from the still-live session or from the
 * email-code reactivation path.
 */
export async function reactivateAccount(userId: string) {
  const current = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!current) throw new Error('User not found');

  await prisma.user.update({ where: { id: userId }, data: { status: 'active' } });
  forgetUserStatus(userId);

  const deactivation = await prisma.userDeactivation.findUnique({ where: { userId } }).catch(() => null);
  if (deactivation) {
    await prisma.userDeactivation.update({ where: { userId }, data: { resumedAt: new Date() } }).catch(() => {});
  }

  await prisma.userStatusEvent.create({
    data: { userId, fromStatus: current.status, toStatus: 'active', reason: 'user_reactivated', actor: 'user', metadata: {} },
  }).catch(() => {});

  await prisma.activityEvent.create({
    data: { userId, kind: 'account.reactivated', title: 'Account reactivated', detail: null, metadata: { targetType: 'user' }, severity: 'info' },
  }).catch(() => {});

  return { status: 'active' as const };
}

/**
 * Revoke every active session for the user except `keepId`. Sessions are active
 * while `revokedAt` is null (the consolidated schema dropped the status column
 * semantics — the stamp is the truth). We keep the requesting session so the
 * lock screen + its cancel/reactivate actions still work.
 */
export async function revokeOtherSessions(userId: string, keepId: string | null) {
  await prisma.userSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(keepId ? { id: { not: keepId } } : {}),
    },
    data: { revokedAt: new Date(), status: 'revoked' as any },
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════
// SHARED SENSITIVE-ACTION OTP CORE
//
// Deletion and reactivation are both "prove you own the sign-in email" steps.
// They share one OTP core — the same `otps` table + hashing signup uses — but
// each gets its OWN kind so a code issued for one can never be spent on the
// other. Keyed by address (email) so exactly one live code per action; wrong
// tries are counted and the code self-destructs past the threshold; the resend
// cooldown (Redis, email-scoped) rate-limits sending.
// ═══════════════════════════════════════════════════════════════════

/** Exported because the mail that carries the code has to state the same
 *  lifetime the core enforces — copy that guesses at it ends up telling the
 *  reader the code died ten minutes before it actually does. */
export const OTP_TTL_MINUTES = 15;
const MAX_OTP_ATTEMPTS = 5;
export const DELETE_OTP_KIND = 'account_delete';

/**
 * Exported for the reauth code (`features/auth/reauthCode.ts`), which is the
 * same "prove you own the account" step under a fourth kind. Deliberately not
 * re-implemented there: expiry, the attempt counter and the self-destruct past
 * `MAX_OTP_ATTEMPTS` are the security-relevant parts, and two copies of those
 * drift. `bind` ties the hash to a piece of context (here the userId), so a
 * code issued for one account can never be spent on another.
 */
export async function issueSensitiveCode(kind: string, email: string, bind: string, userId: string | null): Promise<{ ok: true; code: string } | { ok: false; reason: 'cooldown'; remainingMs: number }> {
  const gate = await enforceResendCooldown(`${kind}:${email.toLowerCase()}`);
  if (!gate.allowed) return { ok: false, reason: 'cooldown', remainingMs: gate.remainingMs };

  const code = generateOtpCode();
  const otpHash = hashOtpCode(`${code}|${bind}`);
  const expiresAt = addMinutes(new Date(), OTP_TTL_MINUTES);

  await prisma.otp.deleteMany({ where: { kind, address: email.toLowerCase() } });
  await prisma.otp.create({ data: { userId, kind, address: email.toLowerCase(), otpHash, expiresAt } });

  return { ok: true, code };
}

/**
 * Exported alongside `issueSensitiveCode` for the reauth code — see the note
 * there. A live row is spent on the first match (one code, one use) and every
 * miss burns an attempt, so a brute force dies with the row.
 */
export async function consumeSensitiveCode(kind: string, email: string, code: string, bind: string): Promise<boolean> {
  const otp = await prisma.otp.findFirst({ where: { kind, address: email.toLowerCase() }, orderBy: { createdAt: 'desc' } });
  if (!otp) return false;
  if (otp.expiresAt < new Date()) {
    await prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
    return false;
  }
  if ((otp.attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
    await prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
    return false;
  }

  const ok = await verifyOtpHash(otp.otpHash, `${code}|${bind}`);
  if (ok) {
    // The delete is the spend. Asking how many rows it removed turns two
    // concurrent verifies of one code into one success — the loser sees 0 and
    // is refused — instead of both reading the live row and both returning
    // true. A failed delete (the database is the problem, not the code) is
    // also a refusal: the row stays live for a retry.
    const spent = await prisma.otp.deleteMany({ where: { id: otp.id } }).catch(() => ({ count: 0 }));
    return spent.count === 1;
  }

  // A miss costs an attempt, and the row self-destructs at the limit, so a
  // brute force dies with the code it is hunting.
  const next = (otp.attempts ?? 0) + 1;
  if (next >= MAX_OTP_ATTEMPTS) {
    await prisma.otp.deleteMany({ where: { id: otp.id } }).catch(() => {});
  } else {
    await prisma.otp.update({ where: { id: otp.id }, data: { attempts: next } }).catch(() => {});
  }
  return false;
}

/** Resolve the account that signs in with this email (primary address or the
 *  legacy users.email column). Used to bind a deletion code to its owner. */
export async function userIdForEmail(email: string): Promise<string | null> {
  const row = await prisma.userEmail.findFirst({ where: { address: email }, select: { userId: true } }).catch(() => null);
  if (row) return row.userId;
  const u = await prisma.user.findUnique({ where: { email }, select: { id: true } }).catch(() => null);
  return u?.id ?? null;
}

// ═══════════════════════════════════════════════════════════════════
// DELETION (two steps: acknowledge → code → 30-day window)
// ═══════════════════════════════════════════════════════════════════

export const DELETION_WINDOW_DAYS = 30;

/** Step two's code, sent to the sign-in email. Bound to the account id so the
 *  code that deletes THIS account can't be replayed on another. */
export function issueDeletionCode(userId: string, email: string): ReturnType<typeof issueSensitiveCode> {
  return issueSensitiveCode(DELETE_OTP_KIND, email, userId, userId);
}

/** Verify the deletion code. Bound to the caller's own userId (from session),
 *  so the email the code was sent to is implied and can't be forged. */
export function consumeDeletionCode(userId: string, code: string): Promise<boolean> {
  // The deletion code is bound to userId; its row's address is the sign-in
  // email. Look it up by userId (the one live row for this account+kind).
  return (async () => {
    const otp = await prisma.otp.findFirst({ where: { userId, kind: DELETE_OTP_KIND }, orderBy: { createdAt: 'desc' } });
    if (!otp) return false;
    if (otp.expiresAt < new Date() || (otp.attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
      await prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
      return false;
    }
    const ok = await verifyOtpHash(otp.otpHash, `${code}|${userId}`);
    if (ok) {
      // Count-checked spend (same contract as consumeSensitiveCode): two
      // concurrent verifies of one deletion code schedule the deletion once,
      // not twice.
      const spent = await prisma.otp.deleteMany({ where: { id: otp.id } }).catch(() => ({ count: 0 }));
      return spent.count === 1;
    }
    // A miss costs an attempt, and the row self-destructs at the limit.
    const next = (otp.attempts ?? 0) + 1;
    if (next >= MAX_OTP_ATTEMPTS) await prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
    else await prisma.otp.update({ where: { id: otp.id }, data: { attempts: next } }).catch(() => {});
    return false;
  })();
}

/** True when a deletion is genuinely in flight (pending + not cancelled + due
 *  in the future). Anything else (executed, cancelled, absent) reads as none. */
export async function activeDeletionFor(userId: string): Promise<{ finalAt: Date } | null> {
  const dr = await prisma.userDeletionRequest.findUnique({
    where: { userId },
    select: { finalAt: true, cancelledAt: true, executedAt: true },
  }).catch(() => null);
  if (!dr || dr.cancelledAt || dr.executedAt) return null;
  return { finalAt: dr.finalAt };
}

/**
 * Schedule deletion after the code has been verified. Sets the distinct
 * lifecycle state (`status='deletion_pending'`) and writes the final date +
 * reason to the UserDeletionRequest (the only store for them), keeps the current
 * session (so the pending screen + its cancel work) and revokes the rest.
 */
export async function scheduleDeletion(userId: string, opts: { reason?: string | null; keepSessionId?: string | null } = {}) {
  const current = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!current) throw new Error('User not found');

  const finalAt = new Date(Date.now() + DELETION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  await prisma.user.update({ where: { id: userId }, data: { status: 'deletion_pending' } });
  forgetUserStatus(userId);

  await prisma.userDeletionRequest.upsert({
    where: { userId },
    create: { userId, reason: opts.reason ?? 'user_requested', finalAt, cancelledAt: null, executedAt: null },
    update: { reason: opts.reason ?? 'user_requested', finalAt, cancelledAt: null, executedAt: null },
  });

  await prisma.userStatusEvent.create({
    data: { userId, fromStatus: current.status, toStatus: 'deletion_pending', reason: opts.reason ?? 'user_requested', actor: 'user', metadata: { finalAt: finalAt.toISOString() } },
  }).catch(() => {});

  await revokeOtherSessions(userId, opts.keepSessionId ?? null);

  await prisma.activityEvent.create({
    data: { userId, kind: 'account.delete-request', title: 'Deletion requested', detail: opts.reason ?? null, metadata: { targetType: 'user', reason: opts.reason ?? null, scheduledAt: finalAt.toISOString() }, severity: 'critical' },
  }).catch(() => {});

  return { finalAt };
}

/**
 * Cancel a scheduled deletion inside the window: request marked cancelled and
 * status restored to active. Refuses if there is no live pending request
 * (nothing to cancel).
 */
export async function cancelDeletion(userId: string): Promise<{ ok: boolean; error?: string }> {
  const active = await activeDeletionFor(userId);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!user) return { ok: false, error: 'User not found' };
  if (!active || user.status !== 'deletion_pending') {
    return { ok: false, error: 'Account is not scheduled for deletion' };
  }

  await prisma.userDeletionRequest.updateMany({ where: { userId }, data: { cancelledAt: new Date() } });
  await prisma.user.update({ where: { id: userId }, data: { status: 'active' } });
  forgetUserStatus(userId);

  await prisma.userStatusEvent.create({
    data: { userId, fromStatus: 'deletion_pending', toStatus: 'active', reason: 'user_cancelled_deletion', actor: 'user', metadata: {} },
  }).catch(() => {});

  await prisma.activityEvent.create({
    data: { userId, kind: 'account.deletion-cancelled', title: 'Deletion cancelled', detail: null, metadata: { targetType: 'user' }, severity: 'info' },
  }).catch(() => {});

  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════
// UNIFIED STATE READ (what the lock screens render from)
// ═══════════════════════════════════════════════════════════════════

export interface AccountState {
  status: string;
  /** The status closes the account — banned | suspended | deletion_pending |
      deactivated | deleted. One flag the gate and the closure screens branch
      on, so no caller has to re-derive "is this a closure?" from the status. */
  blocked: boolean;
  /** The reason behind the current enforcement, when one was recorded. */
  reason: string | null;
  /** When the current enforcement ends (ISO) — a suspension's end, a
      deletion's final date. Null for open-ended states. */
  until: string | null;
  deactivated: boolean;
  deactivatedAt: string | null;
  deactivatedReason: string | null;
  deletionPending: boolean;
  deletionFinalAt: string | null;
  /** The decision row behind a ban or suspension — what an appeal is filed
      against. Null when the closure isn't a restriction. */
  decisionId: string | null;
  /** Whether the live decision has already been appealed, so the closure
      screen can stop offering a second appeal. */
  appealFiled: boolean;
  /** The persisted event reference for the current enforcement state, so the
      in-app lock screens can show/attach it the way a support thread quotes
      it. Null when nothing was ever decided. */
  refCode: string | null;
  signInMethods: SignInMethods;
  connections: ConnectionRow[];
}

export async function readAccountState(userId: string): Promise<AccountState> {
  /* ONE round of reads.
   *
   * The settings gate paints nothing before this answers, so every serial await
   * in here is time a reader spends watching a spinner. The status, the three
   * closure clocks, the live decision, the appeals against it, the ways back in
   * and the connected apps are all rows that can be asked for at the same time.
   *
   * What is left for a second round is the reference code, and only when the
   * account is actually closed — the rare case, and the one where there is no
   * dashboard being withheld behind it. */
  const [user, deactivation, deletionRequest, restriction, links, logins, linkedAt, appealRows, passkeyCount] =
    await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { status: true, passwordHash: true } }).catch(() => null),
      prisma.userDeactivation.findUnique({ where: { userId } }).catch(() => null),
      prisma.userDeletionRequest
        .findUnique({ where: { userId }, select: { reason: true, finalAt: true, cancelledAt: true, executedAt: true } })
        .catch(() => null),
      liveRestrictionRow(userId).catch(() => null),
      effectiveLinks(userId),
      providerLoginRows(userId),
      linkEventDates(userId),
      prisma.userAppeal
        .findMany({ where: { userId }, select: { restrictionId: true } })
        .catch(() => [] as { restrictionId: string }[]),
      prisma.passkey.count({ where: { userId } }).catch(() => 0),
    ]);

  const status = (user?.status as string) ?? 'active';
  // A cancelled or already-executed request is no clock — the same rule
  // `activeDeletionFor` applies, read off the row this round already fetched.
  const active =
    deletionRequest && !deletionRequest.cancelledAt && !deletionRequest.executedAt
      ? { finalAt: deletionRequest.finalAt }
      : null;

  /* A status the rows behind it no longer back is not a closure. Cancelling a
     deletion and coming back from a pause each write two rows, and a read that
     lands between them — or a status some older path left behind — would paint
     the lock screen over an account that is open, which is what makes a
     cancellation look like it did nothing. The clock row owns the answer. */
  const stale =
    (status === 'deletion_pending' && !active) ||
    (status === 'deactivated' && (!deactivation || deactivation.resumedAt));
  const effectiveStatus = stale ? 'active' : status;

  /* The closure's own facts — reason, end date, reference, the decision row —
     come from the single source of truth (features/auth/blockFacts), the same
     one the sign-in answered from, so the settings screen can never describe
     the closure differently from the login form that opened it. The rows it
     would read are already in hand, so they are handed in rather than asked for
     again. For a status that is not a closure it answers null without a query,
     which is almost every account and the whole point of this round. */
  const { blockFactsFor } = await import('@/features/auth/blockFacts');
  const facts = await blockFactsFor(userId, effectiveStatus, { deactivation, deletionRequest, restriction });

  const deactivated = effectiveStatus === 'deactivated' && !!deactivation && !deactivation.resumedAt;
  const deletionPending = effectiveStatus === 'deletion_pending' && !!active;
  const appealFiled = !!facts?.decisionId && appealRows.some((a) => a.restrictionId === facts.decisionId);

  return {
    status: effectiveStatus,
    blocked: !!facts,
    reason: facts?.reason ?? null,
    until: facts?.until ?? null,
    decisionId: facts?.decisionId ?? null,
    appealFiled,
    refCode: facts?.eventId || null,
    deactivated,
    deactivatedAt: deactivated ? deactivation!.pausedAt.toISOString() : null,
    deactivatedReason: deactivated ? deactivation!.reason ?? null : null,
    deletionPending,
    deletionFinalAt: deletionPending ? active!.finalAt.toISOString() : null,
    signInMethods: await signInMethods(userId, { links, passwordHash: user?.passwordHash ?? null, passkeyCount }),
    connections: connectionRows(userId, links, logins, linkedAt),
  };
}
