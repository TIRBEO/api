import { prisma } from '@/infrastructure/db/prisma';
import { generateOtpCode } from '@/features/auth/otp';
import { hashOtpCode, verifyOtpCode as verifyOtpHash } from '@/features/auth/password';
import { enforceResendCooldown } from '@/features/auth/resend-cooldown';
import { addMinutes } from 'date-fns';

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
export type ProviderField = 'googleId' | 'githubId' | 'discordId';

export const PROVIDER_FIELDS: Record<ProviderKey, ProviderField> = {
  google: 'googleId',
  github: 'githubId',
  discord: 'discordId',
};
export const ALL_PROVIDER_FIELDS: ProviderField[] = ['googleId', 'githubId', 'discordId'];
export const PROVIDER_NAMES: Record<ProviderKey, string> = {
  google: 'Google',
  github: 'GitHub',
  discord: 'Discord',
};

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === 'string' && value in PROVIDER_FIELDS;
}

/**
 * OAuth provider ids have no dedicated column anymore — the authoritative link
 * store is `preferences.misc.oauth` ({ [provider]: providerId }). The legacy
 * googleId/githubId/discordId columns still exist and are what the e2e
 * scaffolding writes, so a read that ignored them would "forget" real links.
 * We read the union (misc.oauth wins on conflict) and write BOTH so neither
 * store drifts.
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
  // Keep the legacy column in step so a read that still looks there (and the
  // e2e fixtures that write there) stays truthful.
  await prisma.user
    .update({ where: { id: userId }, data: { [PROVIDER_FIELDS[provider]]: providerId } as any })
    .catch(() => {});
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
  await prisma.user
    .update({ where: { id: userId }, data: { [PROVIDER_FIELDS[provider]]: null } as any })
    .catch(() => {});
}

/** The effective link map: legacy columns unioned with misc.oauth (oauth wins). */
export async function effectiveLinks(userId: string): Promise<Record<string, string>> {
  const [miscOauth, user] = await Promise.all([
    readOauthLinks(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { googleId: true, githubId: true, discordId: true } }).catch(() => null),
  ]);
  const out: Record<string, string> = {};
  for (const provider of Object.keys(PROVIDER_FIELDS) as ProviderKey[]) {
    const field = PROVIDER_FIELDS[provider];
    const legacy = user ? ((user as any)[field] as string | null) : null;
    const link = miscOauth[provider] || legacy || null;
    if (link) out[provider] = link;
  }
  return out;
}

/**
 * When a provider was linked. The OAuth callback files an `oauth.<provider>.connected`
 * activity event; a merge files `account.merge` with the provider in metadata.
 * The oldest such event is the link date. Falls back to the account's own
 * login ledger so a link created before events existed still shows a date.
 */
async function linkedAtFor(userId: string, provider: ProviderKey): Promise<string | null> {
  const ev = await prisma.activityEvent.findFirst({
    where: {
      userId,
      OR: [
        { kind: `oauth.${provider}.connected` },
        { kind: 'account.merge', metadata: { path: ['provider'], equals: provider } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  }).catch(() => null);
  if (ev) return ev.createdAt.toISOString();

  const login = await prisma.userLogin.findFirst({
    where: { userId, success: true, method: provider },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  }).catch(() => null);
  return login ? login.createdAt.toISOString() : null;
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

export async function listConnections(userId: string): Promise<ConnectionRow[]> {
  const [links, logins] = await Promise.all([
    effectiveLinks(userId),
    prisma.userLogin.findMany({
      where: { userId, success: true, method: { in: Object.keys(PROVIDER_FIELDS) } },
      orderBy: { createdAt: 'asc' },
      select: { method: true, createdAt: true },
    }).catch(() => [] as { method: string; createdAt: Date }[]),
  ]);

  const rows: ConnectionRow[] = [];
  for (const provider of Object.keys(PROVIDER_FIELDS) as ProviderKey[]) {
    const used = logins.filter((row) => row.method === provider);
    const accountId = links[provider] ?? null;
    rows.push({
      id: `${userId}:${provider}`,
      provider,
      connected: !!accountId,
      accountId,
      linkedAt: accountId ? await linkedAtFor(userId, provider) : null,
      firstNameUsedAt: used.length ? used[0].createdAt.toISOString() : null,
      lastUsedAt: used.length ? used[used.length - 1].createdAt.toISOString() : null,
    });
  }
  return rows;
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
export async function signInMethods(userId: string): Promise<SignInMethods> {
  const [user, linkMap, passkeyCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }).catch(() => null),
    effectiveLinks(userId),
    prisma.passkey.count({ where: { userId } }).catch(() => 0),
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
 * Reactivation for a SIGNED-OUT deactivated account. Sign-in is refused while
 * deactivated, so the only way back for someone who closed the tab is a code to
 * the email they sign in with. Two steps: request (sends a code, rate-limited)
 * and verify (consumes it and restores the account). Returns a machine-readable
 * code so the UI can distinguish "not deactivated" from a wrong/expired code.
 */
export async function requestReactivationByEmail(email: string): Promise<{ ok: boolean; reason?: string; code?: string }> {
  const userId = await userIdForEmail(email);
  if (!userId) return { ok: false, reason: 'no_account' };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (user?.status !== 'deactivated') return { ok: false, reason: 'not_deactivated' };

  const issued = await issueSensitiveCode(REACTIVATE_OTP_KIND, email, email, userId);
  if (!issued.ok) return { ok: false, reason: 'cooldown' };
  return { ok: true, code: issued.code };
}

export async function reactivateByEmailCode(email: string, code: string): Promise<{ ok: boolean; reason?: string }> {
  const userId = await userIdForEmail(email);
  if (!userId) return { ok: false, reason: 'no_account' };
  const ok = await consumeSensitiveCode(REACTIVATE_OTP_KIND, email, code, email);
  if (!ok) return { ok: false, reason: 'invalid_code' };
  await reactivateAccount(userId);
  return { ok: true };
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
export const REACTIVATE_OTP_KIND = 'account_reactivate';

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
    await prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
  } else {
    const next = (otp.attempts ?? 0) + 1;
    if (next >= MAX_OTP_ATTEMPTS) {
      await prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
    } else {
      await prisma.otp.update({ where: { id: otp.id }, data: { attempts: next } }).catch(() => {});
    }
  }
  return ok;
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
      await prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
    } else {
      const next = (otp.attempts ?? 0) + 1;
      if (next >= MAX_OTP_ATTEMPTS) await prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
      else await prisma.otp.update({ where: { id: otp.id }, data: { attempts: next } }).catch(() => {});
    }
    return ok;
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
 * lifecycle state (`status='deletion_pending'` + a UserDeletionRequest with the
 * final date), mirrors the legacy scheduledDeletionAt column, keeps the current
 * session (so the pending screen + its cancel work) and revokes the rest.
 */
export async function scheduleDeletion(userId: string, opts: { reason?: string | null; keepSessionId?: string | null } = {}) {
  const current = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!current) throw new Error('User not found');

  const finalAt = new Date(Date.now() + DELETION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  await prisma.user.update({ where: { id: userId }, data: { status: 'deletion_pending', scheduledDeletionAt: finalAt, deletionReason: opts.reason ?? null } });

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
 * Cancel a scheduled deletion inside the window: request marked cancelled,
 * status restored to active, the legacy mirror cleared. Refuses if there is no
 * live pending request (nothing to cancel).
 */
export async function cancelDeletion(userId: string): Promise<{ ok: boolean; error?: string }> {
  const active = await activeDeletionFor(userId);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!user) return { ok: false, error: 'User not found' };
  if (!active || user.status !== 'deletion_pending') {
    return { ok: false, error: 'Account is not scheduled for deletion' };
  }

  await prisma.userDeletionRequest.updateMany({ where: { userId }, data: { cancelledAt: new Date() } });
  await prisma.user.update({ where: { id: userId }, data: { status: 'active', scheduledDeletionAt: null, deletionReason: null } });

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
  deactivated: boolean;
  deactivatedAt: string | null;
  deactivatedReason: string | null;
  deletionPending: boolean;
  deletionFinalAt: string | null;
  deletionDaysRemaining: number | null;
  signInMethods: SignInMethods;
  connections: ConnectionRow[];
}

export async function readAccountState(userId: string): Promise<AccountState> {
  const [user, deactivation, active, methods, connections] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { status: true, deletionReason: true } }).catch(() => null),
    prisma.userDeactivation.findUnique({ where: { userId } }).catch(() => null),
    activeDeletionFor(userId),
    signInMethods(userId),
    listConnections(userId),
  ]);

  const status = (user?.status as string) ?? 'active';
  const deactivated = status === 'deactivated' && !!deactivation && !deactivation.resumedAt;
  const deletionPending = status === 'deletion_pending' && !!active;

  return {
    status,
    deactivated,
    deactivatedAt: deactivated ? deactivation!.pausedAt.toISOString() : null,
    deactivatedReason: deactivated ? deactivation!.reason ?? null : null,
    deletionPending,
    deletionFinalAt: deletionPending ? active!.finalAt.toISOString() : null,
    deletionDaysRemaining: deletionPending
      ? Math.max(0, Math.ceil((active!.finalAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : null,
    signInMethods: methods,
    connections,
  };
}
