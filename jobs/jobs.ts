import { prisma } from '@/infrastructure/db/prisma';
import { isEmailPaused } from '@/features/email/emailPrefs';

/** Delete notifications older than 30 days. Runs on startup + hourly. */
export async function cleanupOldNotifications(olderThanDays = 30) {
  const cutoff = new Date(Date.now() - olderThanDays * 86400000);
  const result = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (result.count > 0) console.log(`[CLEANUP] Deleted ${result.count} old notifications (>${olderThanDays} days)`);
  return result.count;
}

/** Start periodic notification cleanup — every hour. */
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
export function startPeriodicCleanup() {
  if (cleanupTimer) return;
  // Run once on startup after 30s, then every hour via setTimeout recursion
  setTimeout(() => { cleanupOldNotifications().catch(() => {}); }, 30_000);
  function scheduleCleanup() {
    cleanupTimer = setTimeout(() => {
      cleanupOldNotifications().catch(() => {});
      scheduleCleanup();
    }, 3_600_000);
  }
  scheduleCleanup();
  console.log('[CLEANUP] Periodic notification cleanup started (hourly)');

  // Permanent deletion of soft-deleted accounts (daily)
  setTimeout(() => {
    import('@/jobs/jobs-permanent-deletion').then(m => m.permanentDeletionJob().catch(() => {}));
  }, 60_000);
  function scheduleDeletion() {
    setTimeout(() => {
      import('@/jobs/jobs-permanent-deletion').then(m => m.permanentDeletionJob().catch(() => {}));
      scheduleDeletion();
    }, 86_400_000); // 24 hours
  }
  scheduleDeletion();
  console.log('[PERMANENT-DELETION] Daily permanent deletion job started');
}

/**
 * The periodic account recap — the only recurring mail Tirbeo sends.
 *
 * There used to be two: a digest of unread notifications and a separate activity
 * summary, each on its own cadence, so someone who turned both on got two
 * overlapping mails about the same week. There is one now, and it lists what the
 * account actually did — grouped the way the activity chart in the settings app
 * groups it — on the rhythm the person chose.
 */
type RecapChoice = {
  summaryEnabled: boolean;
  summaryFrequency: string;
  lastSummarySentAt: string | null;
  mailBlocked: boolean;
};

/** Cadence → minimum interval (ms) between sends. */
export function frequencyToMs(freq: string | null | undefined): number {
  return freq === 'weekly' ? 7 * 86400000 : freq === 'monthly' ? 30 * 86400000 : 86400000;
}

/** Whether enough time has passed since the last send for the given cadence. */
export function isCadenceDue(lastSentAt: string | Date | null | undefined, now: Date, freqMs: number): boolean {
  const last = lastSentAt ? new Date(lastSentAt).getTime() : 0;
  return now.getTime() - last >= freqMs;
}

const obj = (raw: unknown): Record<string, any> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {};

const SUMMARY_FREQUENCIES = ['daily', 'weekly', 'monthly'];

/**
 * One person's recap choice, read out of the two stores that both hold part of
 * the answer.
 *
 * `off` wins wherever it is found: a preference that only half got cleared must
 * never be read as consent to mail somebody. Opting in has to be an explicit
 * `true` in one of the two, so a column default or a missing field is never a
 * subscription. The cadence comes from the account row first, because that is
 * what the settings screen writes; the send clock lives in the mirror alone and
 * this job is its only writer.
 */
/** Exported for the tests: this is the whole decision the sweep makes about one
    account, and it is worth pinning without mailing anybody to prove it. */
export function recapChoice(mirrorRaw: unknown, accountRaw: unknown): RecapChoice {
  const mirror = obj(mirrorRaw);
  const account = obj(accountRaw);
  const raw = account.summaryFrequency ?? mirror.summaryFrequency;
  // The unsubscribe map is an object keyed by category; the older literal `true`
  // is still honoured because a store that once held it must keep holding a no.
  const unsubscribedAll = [mirror, account].some(
    (p) => p.unsubscribed === true || obj(p.unsubscribed).all === true,
  );
  return {
    summaryEnabled: mirror.summaryEnabled !== false && account.summaryEnabled !== false
      && (mirror.summaryEnabled === true || account.summaryEnabled === true),
    summaryFrequency: SUMMARY_FREQUENCIES.includes(raw) ? raw : 'weekly',
    lastSummarySentAt: mirror.lastSummarySentAt ?? null,
    /* A paused account is not due for a recap, and saying so here is what saves
       the letter rather than losing it: the mailer answers a suppressed send
       with a plain "success", so a sweep that mailed into a pause would move the
       send clock forward on a mail nobody got — and the person who paused for a
       week would come back to nothing. Held back at the sweep instead, the clock
       stays where it was and the recap arrives when the pause lapses. */
    mailBlocked: mirror.email === false || account.email === false
      || unsubscribedAll
      || isEmailPaused(mirror) || isEmailPaused(account),
  };
}

/**
 * Move the send clock forward, but only if it still says what this run read.
 * Cron, the per-request kick and the in-process timer can all be sweeping the
 * same account in the same minute; without this, each of them sees "due" and
 * each of them posts.
 */
async function claimSummarySlot(userId: string, expected: string | null, value: string | null): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.userPreferences.findUnique({ where: { userId }, select: { notif: true } });
      const current = obj(row?.notif).lastSummarySentAt ?? null;
      if (current !== expected) return false;
      const next = { ...obj(row?.notif), lastSummarySentAt: value };
      await tx.userPreferences.upsert({
        where: { userId },
        create: { userId, notif: next as any },
        update: { notif: next as any },
      });
      return true;
    });
  } catch (err: any) {
    console.error('[RECAP CLAIM]', err?.message || err);
    return false;
  }
}

/**
 * Send one period's recap, having claimed the slot first, and hand the claim
 * back if the mail fails — so a provider hiccup costs a late recap rather than
 * a silently skipped one.
 */
async function sendOnceClaimed(
  userId: string,
  from: string | null,
  now: Date,
  work: () => Promise<boolean>,
): Promise<boolean> {
  const stamp = now.toISOString();
  if (!(await claimSummarySlot(userId, from, stamp))) return false;
  let sent = false;
  try {
    sent = await work();
  } catch (err: any) {
    console.error('[RECAP SEND]', err?.message || err);
  }
  if (!sent) await claimSummarySlot(userId, stamp, from);
  return sent;
}

/** One pass over every account that asked for a recap and is due for one. */
export async function sendAccountSummaries() {
  try {
    // Either store can hold the answer, so both are asked. The settings screen
    // used to write the account row while the senders read the `notif` mirror,
    // so a person could opt in and never be mailed, or opt out and keep being
    // mailed.
    const candidates = await prisma.$queryRaw<{ userId: string }[]>`
      SELECT "id" AS "userId" FROM "user"."users"
        WHERE COALESCE("notification_preferences" ->> 'summaryEnabled', '') = 'true'
      UNION
      SELECT "user_id" FROM "preferences"."user_preferences"
        WHERE COALESCE("notif" ->> 'summaryEnabled', '') = 'true'
      LIMIT 5000`;
    if (!candidates.length) return;

    const rows = await prisma.user.findMany({
      where: { id: { in: candidates.map((c) => c.userId) } },
      select: {
        id: true,
        status: true,
        notificationPreferences: true,
        emails: { where: { isDefault: true }, select: { address: true }, take: 1 },
        preferences: { select: { notif: true } },
      },
    });

    const now = new Date();
    for (const row of rows) {
      if (row.status !== 'active' || !row.emails?.[0]?.address) continue;
      const choice = recapChoice(row.preferences?.notif, row.notificationPreferences);
      if (!choice.summaryEnabled || choice.mailBlocked) continue;
      const periodMs = frequencyToMs(choice.summaryFrequency);
      if (!isCadenceDue(choice.lastSummarySentAt, now, periodMs)) continue;
      const since = choice.lastSummarySentAt
        ? new Date(Math.max(new Date(choice.lastSummarySentAt).getTime(), now.getTime() - periodMs))
        : new Date(now.getTime() - periodMs);
      await sendOnceClaimed(row.id, choice.lastSummarySentAt, now, () => sendAccountRecap(row.id, since, now));
    }
  } catch (err: any) {
    console.error('[RECAP] Error:', err?.message);
  }
}

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));

const ACTION_LABELS: Record<string, string> = {
  login_success: 'Successful sign-ins',
  login_failed: 'Failed sign-in attempts',
  logout: 'Sign-outs',
  password_change: 'Password changes',
  password_changed: 'Password changes',
  twofactor: '2FA changes',
  passkey: 'Passkey usage',
  device_seen: 'New devices seen',
  recovery_email: 'Recovery email changes',
  phone: 'Phone changes',
  profile_update: 'Profile updates',
  avatar_update: 'Photo updates',
  oauth_connect: 'Accounts connected',
  oauth_disconnect: 'Accounts disconnected',
  apikey_create: 'API keys created',
  apikey_delete: 'API keys removed',
  ticket_create: 'Support tickets opened',
  form_submit: 'Forms submitted',
  export: 'Data exports',
};

function labelFor(action: string): string {
  const lower = action.toLowerCase();
  for (const key of Object.keys(ACTION_LABELS)) {
    if (lower.includes(key.split('_')[0]) && lower.includes(key.split('_').pop()!)) return ACTION_LABELS[key];
  }
  return action.replace(/[_.]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** The five groups the activity chart draws, in the order it draws them. */
const SUMMARY_GROUPS = ['signin', 'security', 'account', 'content', 'other'] as const;
type SummaryGroup = (typeof SUMMARY_GROUPS)[number];

const GROUP_LABELS: Record<SummaryGroup, string> = {
  signin: 'Sign-ins',
  security: 'Security',
  account: 'Account',
  content: 'Content',
  other: 'Other',
};

/**
 * Which group a recorded row belongs to — the same rule the settings app's
 * activity chart uses, matched on the kind's content rather than a fixed list,
 * so a kind the server starts writing tomorrow still lands somewhere sensible
 * instead of vanishing from the counts.
 */
const SIGN_IN_METHODS = new Set(['password', 'google', 'github', 'discord', 'magic', 'otp', 'passkey']);

function groupFor(kind: string): SummaryGroup {
  const k = String(kind || '').toLowerCase();
  if (SIGN_IN_METHODS.has(k)) return 'signin';
  if (k.includes('login') || k.includes('logout') || k.includes('sign')) return 'signin';
  if (
    k.startsWith('security.') || k.includes('password') || k.includes('2fa') || k.includes('totp')
    || k.includes('passkey') || k.includes('backup_code') || k.includes('recovery') || k.includes('merge')
  ) return 'security';
  if (k.startsWith('form.') || k.startsWith('content.') || k.startsWith('application.') || k.startsWith('ai.')) return 'content';
  if (
    k.startsWith('profile.') || k.startsWith('user.') || k.startsWith('settings') || k.startsWith('preference')
    || k.startsWith('notification') || k.startsWith('consent') || k.startsWith('theme') || k.startsWith('language')
  ) return 'account';
  return 'other';
}

const LIST_ROW = 'padding:12px 16px;border-bottom:1px solid #2a2a2c;';

/** One line of the recap: what happened, when, and where it came from. */
function recapLine(title: string, at: Date, note?: string | null): string {
  const when = at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<div style="${LIST_ROW}"><div style="color:#ffffff;font-size:14px;line-height:22px;">${esc(title)}</div>`
    + `<div style="color:#8a8a8e;font-size:13px;line-height:20px;padding-top:2px;">${esc(when)}${note ? ` · ${esc(note)}` : ''}</div></div>`;
}

/** Build & send one account recap. Returns true only when the mail went out. */
export async function sendAccountRecap(userId: string, since: Date, until: Date): Promise<boolean> {
  try {
    const [events, logins] = await Promise.all([
      prisma.activityEvent.findMany({
        where: { userId, createdAt: { gte: since, lte: until } },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: { kind: true, title: true, detail: true, severity: true, createdAt: true },
      }),
      prisma.userLogin.findMany({
        where: { userId, createdAt: { gte: since, lte: until } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { method: true, success: true, location: true, userAgent: true, createdAt: true },
      }),
    ]);

    const lists = new Map<SummaryGroup, string[]>();
    const add = (group: SummaryGroup, line: string) => {
      const existing = lists.get(group) || [];
      existing.push(line);
      lists.set(group, existing);
    };
    for (const login of logins) {
      const from = login.location || login.userAgent || '';
      add('signin', recapLine(
        login.success ? `Signed in with ${labelFor(login.method)}` : `Failed sign-in with ${labelFor(login.method)}`,
        login.createdAt, from,
      ));
    }
    for (const event of events) add(groupFor(event.kind), recapLine(event.title, event.createdAt, event.detail));

    const groupsHtml = SUMMARY_GROUPS
      .filter((group) => (lists.get(group) || []).length)
      .map((group) => {
        const lines = lists.get(group)!;
        const shown = lines.slice(0, 12);
        return `<div>`
          + `<p style="margin:0;padding:14px 16px 4px;font-size:14px;font-weight:600;color:#ffffff;line-height:22px;">${GROUP_LABELS[group]}`
          + ` <span style="color:#8a8a8e;font-weight:400;">· ${lines.length}</span></p>`
          + shown.join('')
          + (lines.length > shown.length
            ? `<div style="padding:10px 16px;font-size:13px;line-height:20px;color:#8a8a8e;">${lines.length - shown.length} more in your activity history</div>`
            : '')
          + `</div>`;
      })
      .join('');
    const listsHtml = groupsHtml
      ? `<div style="background:#18181a;border:1px solid #2a2a2c;border-radius:14px;margin:0 0 20px;">${groupsHtml}</div>`
      : '';

    const attention = [
      ...logins.filter((l) => !l.success)
        .map((l) => `Failed sign-in${l.location ? ` from ${l.location}` : ''} on ${l.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`),
      ...events
        .filter((e) => ['warning', 'error', 'critical'].includes(String(e.severity || '').toLowerCase()))
        .map((e) => e.title),
    ];
    const suspiciousSection = attention.length
      ? `<div style="margin:0 0 20px;">`
        + `<p style="margin:0 0 6px;font-size:14px;font-weight:600;color:#ffffff;line-height:22px;">${attention.length} thing${attention.length === 1 ? '' : 's'} to look at</p>`
        + attention.slice(0, 6).map((line) =>
            `<p style="margin:0;font-size:13px;line-height:20px;color:#8a8a8e;">· ${esc(line)}</p>`).join('')
        + `</div>`
      : '';

    const total = events.length + logins.length;
    const statRows = total
      ? listsHtml
      : `<p style="margin:0;font-size:14px;line-height:22px;color:#8a8a8e;">Nothing was recorded on your account in this period — no sign-ins, no changes, no security events.</p>`;

    const day = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const periodLabel = `${day(since)} – ${day(until)}`;

    const { fetchLoginUserById } = await import('@/features/identity/tirbeo');
    const user = await fetchLoginUserById(userId);
    if (!user?.email) return false;

    const { sendTemplateEmail } = await import('@/features/email/email');
    const result = await sendTemplateEmail(user.email, 'weekly_summary', {
      name: user.name || user.email,
      periodLabel,
      statRows,
      suspiciousSection,
    }, { categoryOverride: 'digest', userId }).catch(() => ({ success: false }));

    if (result?.success) console.log(`[RECAP] ${total} rows (${logins.length} sign-ins, ${events.length} changes) → ${user.email} · ${periodLabel}`);
    return !!result?.success;
  } catch (err: any) {
    console.error('[RECAP] Failed:', err?.message);
    return false;
  }
}

/** Start periodic recap sending. Checks every hour; each account's own cadence decides who is due. */
let summaryTimer: ReturnType<typeof setTimeout> | null = null;
export function startPeriodicSummaries() {
  if (summaryTimer) return;
  setTimeout(() => { sendAccountSummaries().catch(() => {}); }, 60_000);
  function scheduleSummary() {
    summaryTimer = setTimeout(() => {
      sendAccountSummaries().catch(() => {});
      scheduleSummary();
    }, 3_600_000);
  }
  scheduleSummary();
  console.log('[RECAP] Periodic account recap started (hourly check)');
}

// ─── SCHEDULED ACCOUNT DELETIONS ───
// The single implementation lives in userHandlers.ts (processScheduledDeletions)
// — it hard-deletes past-grace accounts and is shared by the hourly server job
// and the admin panel. The earlier anonymize-variant here was removed as a
// duplicate with DIFFERENT semantics.

let deletionTimer: ReturnType<typeof setTimeout> | null = null;
export function startPeriodicDeletionSweep() {
  if (deletionTimer) return;
  function scheduleDeletionSweep() {
    deletionTimer = setTimeout(() => {
      import('@/features/users/userHandlers').then(m => m.processScheduledDeletions()).catch(() => {});
      scheduleDeletionSweep();
    }, 3_600_000);
  }
  scheduleDeletionSweep();
}

let pushPruneTimer: ReturnType<typeof setTimeout> | null = null;
export function startPeriodicPushPrune() {
  if (pushPruneTimer) return;
  // Run once after 5m, then nightly (24h) via setTimeout recursion
  setTimeout(() => { import('@/infrastructure/push/push-notifications').then(m=> m.pruneStalePushSubscriptions().catch(()=>{}) ) }, 5*60_000);
  function schedulePushPrune() {
    pushPruneTimer = setTimeout(() => {
      import('@/infrastructure/push/push-notifications').then(m=> m.pruneStalePushSubscriptions().catch(()=>{}));
      schedulePushPrune();
    }, 86_400_000);
  }
  schedulePushPrune();
  console.log('[PUSH] periodic prune started (nightly, >60d stale)');
}

// ─── REACTIVATION EMAILS ───
// Sends a "we miss you" email to users who haven't been active for 7+ days.
// It is campaign mail, so it answers to the settings page's own
// "Offers and promotions" switch (offersEmail) and nothing sends without it.
// Rate-limited: one reactivation email per user per 30 days.

export async function sendReactivationEmails() {
  try {
    const cutoff7d = new Date(Date.now() - 7 * 86400_000);
    const cutoff30d = new Date(Date.now() - 30 * 86400_000);

    // Find users inactive for 7+ days who are eligible. Reactivation mail is
    // opt-in: offersEmail must be explicitly true. Either store can hold the
    // answer — the settings screen writes the account row and mirrors it into
    // `notif` — so both are asked, the same way the recap sweep asks both.
    const candidates = await prisma.$queryRaw<{ userId: string }[]>`
      SELECT "id" AS "userId" FROM "user"."users"
        WHERE COALESCE("notification_preferences" ->> 'offersEmail', '') = 'true'
      UNION
      SELECT "user_id" FROM "preferences"."user_preferences"
        WHERE COALESCE("notif" ->> 'offersEmail', '') = 'true'
      LIMIT 2000`;
    if (!candidates.length) return;

    const rows = await prisma.user.findMany({
      where: { id: { in: candidates.map((c) => c.userId) } },
      select: {
        id: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        profile: { select: { name: true } },
        emails: { where: { isDefault: true }, select: { address: true }, take: 1 },
      },
    });

    const users = rows
      .filter(r => r.status === 'active' && new Date(r.updatedAt) < cutoff7d)
      .map(r => ({
        id: r.id,
        email: r.emails?.[0]?.address || '',
        name: r.profile?.name || null,
        lastActiveAt: r.updatedAt,
        createdAt: r.createdAt,
      }))
      .filter(u => u.email);

    if (users.length === 0) return;

    const { sendTemplateEmail } = await import('@/features/email/email');
    const { getDashboardBaseUrl } = await import('@/config/app-urls');
    const { loadNotificationPrefs } = await import('@/features/notifications/notifications');
    const dashboardUrl = getDashboardBaseUrl();

    // Check recent sends to avoid re-mailing within 30 days
    const recentLogs = await prisma.email_jobs.findMany({
      where: {
        toAddress: { in: users.map(u => u.email) },
        templateSlug: 'reactivation',
        createdAt: { gt: cutoff30d },
      },
      select: { toAddress: true },
      distinct: ['toAddress'],
    }).catch(() => [] as any[]);
    const alreadySent = new Set(recentLogs.map(r => r.toAddress));

    let sentCount = 0;
    for (const u of users) {
      if (!u.email) continue;
      if (alreadySent.has(u.email)) continue;

      // Ask the one function that reads a preference, merged, rather than
      // whichever store this sweep happened to query: reading only the mirror
      // is how a person who turned the switch off on the page kept being
      // mailed. Opt-in still means an explicit true — no stored answer is a no.
      const prefs: any = await loadNotificationPrefs(u.id);
      if (!prefs || prefs.email === false) continue;
      if (prefs.offers === false || prefs.offersEmail !== true) continue;
      const unsub = obj(prefs.unsubscribed);
      if (prefs.unsubscribed === true || unsub.all === true || unsub.offers === true) continue;
      // A paused account gets no campaign mail either — and, unlike the mailer,
      // this sweep has no send clock to mislead afterwards.
      if (isEmailPaused(prefs)) continue;

      // Calculate days since last active
      const lastActive = u.lastActiveAt ? new Date(u.lastActiveAt).getTime() : new Date(u.createdAt).getTime();
      const daysSince = Math.max(1, Math.floor((Date.now() - lastActive) / 86400_000));

      // Build a brief activity summary
      let activitySummary = '<p style="margin:0;font-size:14px;line-height:22px;color:#8a8a8e;">No recent activity recorded. Your workspace is waiting.</p>';
      try {
        const recentNotifs = await prisma.notification.findMany({
          where: { userId: u.id, createdAt: { gte: cutoff7d } },
          select: { title: true },
          take: 5,
        });
        if (recentNotifs.length > 0) {
          activitySummary = recentNotifs.map(n =>
            `<div style="padding:14px 16px;background:#18181a;border:1px solid #2a2a2c;border-radius:14px;margin-bottom:8px;font-size:14px;line-height:22px;color:#ffffff;">${esc(n.title)}</div>`
          ).join('');
        }
      } catch {}

      const result = await sendTemplateEmail(u.email, 'reactivation', {
        name: u.name || u.email,
        daysSince: String(daysSince),
        activitySummary,
        dashboardUrl,
      }, { rawVars: ['activitySummary'], userId: u.id }).catch(() => ({ success: false }));

      if (result?.success) sentCount++;
    }

    if (sentCount > 0) console.log(`[REACTIVATION] Sent ${sentCount} reactivation emails`);
  } catch (err: any) {
    console.error('[REACTIVATION] Sweep error:', err?.message);
  }
}

let reactivationTimer: ReturnType<typeof setTimeout> | null = null;
export function startPeriodicReactivation() {
  if (reactivationTimer) return;
  // Run once after 10 min, then every 6 hours via setTimeout recursion
  setTimeout(() => { sendReactivationEmails().catch(() => {}); }, 10 * 60_000);
  function scheduleReactivation() {
    reactivationTimer = setTimeout(() => {
      sendReactivationEmails().catch(() => {});
      scheduleReactivation();
    }, 6 * 3_600_000);
  }
  scheduleReactivation();
  console.log('[REACTIVATION] Periodic reactivation emails started (every 6h)');
}
