import { prisma } from '@/infrastructure/db/prisma';
import { readRecoveryContact } from '@/features/identity/tirbeo';
import { loadNotificationPrefs } from '@/features/notifications/notifications';

export interface AccountTip {
  id: string;
  title: string;
  body: string;
  /** Path inside the settings app, e.g. '/settings/two-factor'. */
  path: string;
  actionLabel: string;
}

/**
 * Security tips.
 *
 * A tip is only ever about something this account does not have. The earlier
 * version also proposed adding a bio, a profile photo, an API key, or "turn
 * product updates back on" — that last one especially: mailing somebody to talk
 * them out of a switch they just turned off is not a tip, it is a dark pattern.
 * An account with every protection set gets nothing, which is the correct
 * outcome and why there is no longer a filler tip at the end.
 */
export async function computeTips(userId: string): Promise<AccountTip[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      emailVerified: true,
      is2FAEnabled: true,
      security: { select: { mustChangePw: true, backupCodes: true } },
      phone: { select: { number: true } },
      _count: { select: { passkeys: true } },
    },
  });
  if (!user) return [];

  const backupCodes = Array.isArray((user.security as any)?.backupCodes)
    ? (user.security as any).backupCodes.length : 0;
  const tips: AccountTip[] = [];

  if (!user.is2FAEnabled) {
    tips.push({
      id: 'enable-2fa',
      title: 'A second step at sign-in',
      body: 'Two-factor keeps your account yours even if your password leaks somewhere else. Any authenticator app works and it takes about half a minute.',
      path: '/settings/two-factor',
      actionLabel: 'Turn on two-factor',
    });
  }

  if (user._count.passkeys === 0) {
    tips.push({
      id: 'add-passkey',
      title: 'Sign in without a password',
      body: 'A passkey uses your fingerprint or face, so there is nothing to guess, nothing to phish and nothing to remember.',
      path: '/settings/passkeys',
      actionLabel: 'Create a passkey',
    });
  }

  if (user.is2FAEnabled && backupCodes === 0) {
    tips.push({
      id: 'backup-codes',
      title: 'Keep backup codes for when your phone is gone',
      body: 'If you lose the device your authenticator lives on, backup codes are the only way back in. Store them somewhere you trust.',
      path: '/settings/backup-codes',
      actionLabel: 'Get backup codes',
    });
  }

  const recovery = await readRecoveryContact(userId);
  if (!recovery?.email || !recovery.verified) {
    tips.push({
      id: 'recovery-email',
      title: 'Add a recovery email',
      body: 'A second address you verified gives you a way back if you ever lose access to your main inbox.',
      path: '/settings/personal-details',
      actionLabel: 'Add recovery email',
    });
  }

  if (!user.phone?.number) {
    tips.push({
      id: 'add-phone',
      title: 'Add a phone number',
      body: 'A verified phone is another route back into your account when everything else has failed.',
      path: '/settings/personal-details',
      actionLabel: 'Add a phone number',
    });
  }

  if (!user.emailVerified) {
    tips.push({
      id: 'verify-email',
      title: 'Confirm your email address',
      body: 'Until your address is confirmed we cannot reliably reach you about anything on this account, including a sign-in we did not expect.',
      path: '/settings/personal-details',
      actionLabel: 'Verify my email',
    });
  }

  if (user.security?.mustChangePw) {
    tips.push({
      id: 'set-password',
      title: 'Set a password of your own',
      body: 'This account was created without one, so the password it does have was assigned rather than chosen — worth replacing.',
      path: '/settings/security',
      actionLabel: 'Choose a password',
    });
  }

  const staleSessions = await prisma.userSession.count({
    where: { userId, status: 'active', lastUsedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } },
  }).catch(() => 0);

  if (staleSessions > 0) {
    tips.push({
      id: 'review-sessions',
      title: `${staleSessions} sign-in${staleSessions === 1 ? '' : 's'} you have not used in a month`,
      body: 'Old sessions outlive the device they started on. Ending the ones you do not recognise closes doors you stopped needing.',
      path: '/settings/devices',
      actionLabel: 'Review my devices',
    });
  }

  const concerns = await prisma.securityEvent.count({
    where: { userId, severity: { in: ['warning', 'error', 'critical'] }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
  }).catch(() => 0);

  if (concerns >= 3) {
    tips.unshift({
      id: 'review-security-events',
      title: `Look at the ${concerns} security events from the last month`,
      body: 'We recorded several security events on this account recently. Reading them is how you tell an odd device from an intruder.',
      path: '/settings/security',
      actionLabel: 'Review activity',
    });
  }

  return tips;
}

const DAY = 86_400_000;
const MIN_INTERVAL_DAYS = 3;
const MAX_INTERVAL_DAYS = 21;

/**
 * Stable hash — the same input always the same number.
 */
function hash32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * When this account's next tip is allowed to go out.
 *
 * The sweep runs on a clock, and "an account gets mail at the same minute every
 * time" is a signature people notice. So each account gets its own spacing AND
 * its own minute and hour, drawn from the account id plus the moment the last
 * tip went out — which means the time changes with every send rather than
 * repeating forever. Deterministic per pair, so a restart mid-sweep does not
 * move the goalposts and send twice.
 */
function nextTipDueAt(userId: string, lastSentAt: number, createdAt: Date | null): number {
  const anchor = lastSentAt || (createdAt ? new Date(createdAt).getTime() + DAY : 0);
  if (!anchor) return Date.now();
  const seed = hash32(`${userId}:${lastSentAt}`);
  const days = MIN_INTERVAL_DAYS + (seed % (MAX_INTERVAL_DAYS * 1440)) / 1440;
  const jitterMs = (seed % 86_400_000) + ((hash32(`${userId}:h:${lastSentAt}`) % 3_600_000));
  return anchor + days * DAY + jitterMs;
}

/**
 * The candidate set. The jsonb predicates here are a cheap prefilter over the
 * store the settings screens write; sendNextTipForUser asks the merged view, so
 * this query only has to avoid obviously unqualified rows.
 */
async function eligibleUserIds(): Promise<Array<{ id: string; createdAt: Date | null }>> {
  return prisma.$queryRaw<{ id: string; createdAt: Date | null }[]>`
    SELECT "id", "created_at" AS "createdAt"
    FROM "user"."users"
    WHERE "deleted_at" IS NULL AND "is_banned" = false AND "is_suspended" = false
      AND COALESCE(("notification_preferences" ->> 'tipsEmail')::boolean, false)
      AND COALESCE(("notification_preferences" ->> 'email')::boolean, true)
    LIMIT 2000`;
}

export async function nextUnsentTip(userId: string): Promise<AccountTip | null> {
  const [tips, sent] = await Promise.all([
    computeTips(userId),
    prisma.userTipLog.findMany({ where: { userId }, select: { tipId: true } }),
  ]);
  if (tips.length === 0) return null;
  const sentIds = new Set(sent.map((s) => s.tipId));
  const candidates = tips.filter((tip) => !sentIds.has(tip.id));
  if (candidates.length === 0) return null;
  // Random order, not "always the most important one first": whichever gap this
  // account learns about, it should not be the same one every time.
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export async function sendNextTipForUser(userId: string): Promise<boolean> {
  try {
    const prefs = await loadNotificationPrefs(userId);
    if (!tipsEligible(prefs)) return false;

    const tip = await nextUnsentTip(userId);
    if (!tip) return false;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!user?.email) return false;

    const { sendTemplateEmail } = await import('@/features/email/email');
    const { getDashboardBaseUrl } = await import('@/config/app-urls');
    const result = await sendTemplateEmail(user.email, 'security_tip', {
      name: user.name || user.email,
      tipTitle: tip.title,
      tipBody: tip.body,
      actionUrl: `${getDashboardBaseUrl()}${tip.path}`,
      actionLabel: tip.actionLabel,
    }, { userId }).catch(() => ({ success: false }));
    if (!result.success) return false;

    await prisma.userTipLog.create({ data: { userId, tipId: tip.id } }).catch(() => {});
    console.log(`[TIPS] Sent '${tip.id}' to ${user.email}`);
    return true;
  } catch (err: any) {
    console.error('[TIPS] sendNextTipForUser failed:', err?.message);
    return false;
  }
}

/**
 * Tips mail is opt-in, and a pause or an unsubscribed address outranks the
 * opt-in. The senders in emailPrefs enforce the same rules — this only avoids
 * building a mail for somebody who already said no.
 */
function tipsEligible(prefs: any): boolean {
  if (!prefs || prefs.email === false) return false;
  if (prefs.tips === false || prefs.tipsEmail !== true) return false;
  return true;
}

export async function runAutoTipsSweep() {
  try {
    const eligible = await eligibleUserIds();
    if (eligible.length === 0) return;

    const ids = eligible.map((u) => u.id);
    const lastSentRows = await prisma.$queryRaw<Array<{ userId: string; lastSentAt: Date }>>`
      SELECT "user_id" AS "userId", MAX("sent_at") AS "lastSentAt"
      FROM "activity"."user_tip_logs"
      WHERE "user_id" = ANY(${ids})
      GROUP BY "user_id"`;
    const lastSent = new Map(lastSentRows.map((row) => [row.userId, new Date(row.lastSentAt).getTime()]));

    const now = Date.now();
    let sentCount = 0;
    for (const user of eligible) {
      if (now < nextTipDueAt(user.id, lastSent.get(user.id) || 0, user.createdAt)) continue;
      if (await sendNextTipForUser(user.id)) sentCount++;
    }
    if (sentCount > 0) console.log(`[TIPS] Sweep complete — ${sentCount} tip${sentCount === 1 ? '' : 's'} sent`);
  } catch (err: any) {
    console.error('[TIPS] Sweep error:', err?.message);
  }
}

let tipsTimeout: ReturnType<typeof setTimeout> | null = null;

// Checking often is what makes a random minute-of-day mean anything: with an
// hourly check the jitter below would be rounded up to the next hour.
const SWEEP_EVERY_MS = 15 * 60_000;

function scheduleNextSweep() {
  if (tipsTimeout) clearTimeout(tipsTimeout);
  tipsTimeout = setTimeout(() => {
    runAutoTipsSweep().catch(() => {}).finally(() => scheduleNextSweep());
  }, SWEEP_EVERY_MS);
}

export function startPeriodicTips() {
  if (tipsTimeout) return;
  setTimeout(() => { runAutoTipsSweep().catch(() => {}); }, 2 * 60_000);
  scheduleNextSweep();
  console.log(`[TIPS] Periodic security tips started (check every ${SWEEP_EVERY_MS / 60_000}min, one tip per account every 3-21 days)`);
}
