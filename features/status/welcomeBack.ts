import { NextRequest, NextResponse } from 'next/server';
import type { UserStatusKind } from '@prisma/client';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { jsonUnauthorized } from '@/shared/response';

/* ═══════════════════════════════════════════════════════════════════
   Welcome back — the one acknowledgment a restored account deserves.

   When an account comes back from a blocked state (a ban or suspension
   lifted, a deactivation undone, a scheduled deletion cancelled), the
   person's next signed-in request can ask ONE question of the brain:
   "was I recently restored, and how was it done?" The answer is computed
   from user_status_events — the ledger the lifecycle functions already
   write — so there is no second store to keep in sync:

     • the newest event with toStatus='active' whose fromStatus is one of
       the blocked states is the reinstatement itself;
     • the newest earlier event that moved the account INTO that blocked
       state is when the pause began (pausedAt);
     • actor says who opened the door ('admin' = staff reinstated it,
       'user' = the person recovered it themselves), reason carries why.

   The card is one-shot: once acknowledged (POST .../ack writes
   misc.welcomeBackSeenAt), any reinstatement at or before that moment is
   considered shown and the endpoint answers null. The ack marker lives in
   `preferences.user_preferences.misc`, outside `misc.settings`, merged
   write-style exactly like the OAuth links and the account-status level
   (see accountLifecycle readMisc / writeOauthLink) — one shared misc blob,
   never stomping the keys that live alongside it.
   ═══════════════════════════════════════════════════════════════════ */

const BLOCKED_FROM_STATUSES: UserStatusKind[] = ['banned', 'suspended', 'deactivated', 'deletion_pending'] as UserStatusKind[];

export interface WelcomeBackInfo {
  /** The blocked state the account was restored FROM. */
  from: string;
  /** ISO instant the blocked state began. */
  pausedAt: string;
  /** ISO instant of the reinstatement event. */
  restoredAt: string;
  /** Whole days (rounded up) between the two — how long the account was off. */
  daysOff: number;
  /** 'admin' when staff made it happen, 'user' when the person did. */
  actor: string;
  /** The reinstatement's recorded reason (e.g. 'user_reactivated',
   *  'user_cancelled_deletion', or the free-text reason staff entered). */
  reason: string | null;
}

const asObj = (raw: unknown): Record<string, any> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {};

/** Read the misc bag without ever throwing at a missing/corrupt row — same
 *  forgiving shape as accountLifecycle's readMisc. */
async function readMisc(userId: string): Promise<Record<string, any>> {
  const p = await prisma.userPreferences.findUnique({ where: { userId }, select: { misc: true } }).catch(() => null);
  return asObj(p?.misc);
}

/** Merge-write one key into misc, preserving everything that shares the bag
 *  (settings, consents, oauth, accountStatus) — accountLifecycle's
 *  writeOauthLink pattern exactly. */
async function writeMiscKey(userId: string, key: string, value: unknown): Promise<void> {
  const misc = { ...(await readMisc(userId)) };
  misc[key] = value;
  await prisma.userPreferences.upsert({
    where: { userId },
    update: { misc },
    create: { userId, misc },
  }).catch(() => {});
}

/**
 * The welcome-back card for this account, or null when there is nothing to
 * show: never blocked-and-restored, or already acknowledged after the
 * restoration happened.
 */
export async function getWelcomeBack(userId: string): Promise<WelcomeBackInfo | null> {
  const restore = await prisma.userStatusEvent.findFirst({
    where: { userId, toStatus: 'active', fromStatus: { in: BLOCKED_FROM_STATUSES } },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null);
  if (!restore || !restore.fromStatus) return null;

  // Already-seen gate: an ack stamped at/after this reinstatement swallows it.
  const seenRaw = (await readMisc(userId)).welcomeBackSeenAt;
  const seenAt = typeof seenRaw === 'string' || seenRaw instanceof Date ? new Date(seenRaw) : null;
  if (seenAt && !Number.isNaN(seenAt.getTime()) && restore.createdAt <= seenAt) return null;

  // When the pause began: the newest earlier event that moved the account
  // INTO the blocked state the restore came out of. Older data may not have
  // filed that event, so fall back to a pausedAt carried in the restore's
  // own metadata, and finally to the restore instant (daysOff reads as 0).
  const paused = await prisma.userStatusEvent.findFirst({
    where: { userId, toStatus: restore.fromStatus as any, createdAt: { lt: restore.createdAt } },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null);
  const metaPaused = asObj(restore.metadata).pausedAt;
  const pausedAt = paused?.createdAt
    ?? (metaPaused ? new Date(metaPaused as string) : null)
    ?? restore.createdAt;

  const hoursOff = (restore.createdAt.getTime() - pausedAt.getTime()) / 3_600_000;
  return {
    from: String(restore.fromStatus),
    pausedAt: pausedAt.toISOString(),
    restoredAt: restore.createdAt.toISOString(),
    daysOff: Math.max(0, Math.ceil(hoursOff / 24)),
    // 'admin' means the reinstatement was staff-made; 'user' (and anything
    // else) means the person recovered the account themselves.
    actor: restore.actor === 'admin' ? 'admin' : 'user',
    reason: restore.reason ?? null,
  };
}

/** GET /api/users/welcome-back → { welcomeBack: {...} | null }. */
export async function welcomeBackHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const welcomeBack = await getWelcomeBack(session.userId);
    return NextResponse.json({ welcomeBack });
  } catch (err: any) {
    console.error('[WELCOME-BACK]', err?.message || err);
    return NextResponse.json({ error: 'Failed to read welcome-back state' }, { status: 500 });
  }
}

/** POST /api/users/welcome-back/ack — "I have seen it". Stamps
 *  misc.welcomeBackSeenAt with now, so the current card never shows again
 *  and only a FUTURE restoration can surface a new one. */
export async function welcomeBackAckHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const seenAt = new Date().toISOString();
    await writeMiscKey(session.userId, 'welcomeBackSeenAt', seenAt);
    return NextResponse.json({ ok: true, seenAt });
  } catch (err: any) {
    console.error('[WELCOME-BACK ACK]', err?.message || err);
    return NextResponse.json({ error: 'Failed to acknowledge welcome-back' }, { status: 500 });
  }
}
