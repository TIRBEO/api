import { prisma } from '@/infrastructure/db/prisma';

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
 * Send email digests based on user preferences.
 * Two independent periodic emails:
 *  1. Unread-notifications digest — digestEnabled + digestFrequency (daily/weekly/monthly)
 *  2. Weekly activity summary — weeklySummary flag; real audit/security logs of the past week
 * Both are rate-limited with last_digest_sent_at / last_weekly_sent_at so the
 * hourly job never double-sends.
 */
export interface DigestPrefs {
  digestEnabled: boolean;
  digestFrequency: 'daily' | 'weekly' | 'monthly';
  weeklySummary: boolean;
  weeklySummaryFrequency: 'daily' | 'weekly' | 'monthly';
  lastDigestSentAt?: string | null;
  lastWeeklySentAt?: string | null;
}

/** Cadence → minimum interval (ms) between sends. */
export function frequencyToMs(freq: string | null | undefined): number {
  return freq === 'weekly' ? 7 * 86400000 : freq === 'monthly' ? 30 * 86400000 : 86400000;
}

/** Whether enough time has passed since the last send for the given cadence. */
export function isCadenceDue(lastSentAt: string | Date | null | undefined, now: Date, freqMs: number): boolean {
  const last = lastSentAt ? new Date(lastSentAt).getTime() : 0;
  return now.getTime() - last >= freqMs;
}

export async function sendEmailDigests() {
  try {
    // SQL-filter users who opted in — only digestEnabled or weeklySummary users
    // are loaded, so the hourly sweep never iterates the whole user table.
    const users = await prisma.$queryRaw<Array<{
      id: string; email: string; name: string | null;
      digestEnabled: boolean; digestFrequency: string | null;
      weeklySummary: boolean;
      weeklySummaryFrequency: string | null;
      lastDigestSentAt: string | null; lastWeeklySentAt: string | null;
    }>>`
      SELECT
        u."id", u."email", u."name",
        COALESCE((u."notification_preferences"->>'digestEnabled')::boolean, false) AS "digestEnabled",
        u."notification_preferences"->>'digestFrequency' AS "digestFrequency",
        COALESCE((u."notification_preferences"->>'weeklySummary')::boolean, false) AS "weeklySummary",
        u."notification_preferences"->>'weeklySummaryFrequency' AS "weeklySummaryFrequency",
        u."notification_preferences"->>'lastDigestSentAt' AS "lastDigestSentAt",
        u."notification_preferences"->>'lastWeeklySentAt' AS "lastWeeklySentAt"
      FROM "users" u
      WHERE u."deleted_at" IS NULL AND u."is_banned" = false
        AND (u."notification_preferences"->>'email')::boolean IS NOT FALSE
        AND (
          COALESCE((u."notification_preferences"->>'digestEnabled')::boolean, false) = true
          OR COALESCE((u."notification_preferences"->>'weeklySummary')::boolean, false) = true
        )
      LIMIT 5000`;

    const now = new Date();
    const { sendTemplateEmail } = await import('@/features/email/email');
    const { getDashboardBaseUrl } = await import('@/config/app-urls');
    const dashboardUrl = getDashboardBaseUrl();

    for (const row of users) {
      const digestEnabled = row.digestEnabled === true;
      const weeklySummary = row.weeklySummary === true;
      if (!digestEnabled && !weeklySummary) continue;
      // Keep the shape the rest of the function already reads.
      const prefs: Partial<DigestPrefs> = {
        digestEnabled,
        weeklySummary,
        digestFrequency: (row.digestFrequency === 'weekly' || row.digestFrequency === 'monthly')
          ? row.digestFrequency as 'weekly' | 'monthly'
          : 'daily',
        lastDigestSentAt: row.lastDigestSentAt,
        lastWeeklySentAt: row.lastWeeklySentAt,
      };
      const u = { id: row.id, email: row.email, name: row.name, notificationPreferences: prefs };
      const freqMs = frequencyToMs(prefs.digestFrequency);
      try {
        // ── 1. Unread-notifications digest ──
        if (digestEnabled) {
          if (isCadenceDue(prefs.lastDigestSentAt, now, freqMs)) {
            const lastSentMs = prefs.lastDigestSentAt ? new Date(prefs.lastDigestSentAt).getTime() : 0;
            const cutoff = new Date(Math.max(lastSentMs, now.getTime() - freqMs));

            // Gather notifications + activity in parallel
            const [notifs, audits, secEvents] = await Promise.all([
              prisma.notification.findMany({
                where: { userId: u.id, isRead: false, createdAt: { gte: cutoff }, type: { notIn: ['product'] } },
                orderBy: { createdAt: 'desc' }, take: 50,
                select: { id: true, title: true, body: true, createdAt: true },
              }),
              prisma.auditEvent.findMany({
                where: { actorId: u.id, createdAt: { gte: cutoff } },
                select: { action: true, severity: true, createdAt: true },
                take: 200,
              }),
              prisma.securityEvent.findMany({
                where: { userId: u.id, createdAt: { gte: cutoff } },
                select: { eventType: true, severity: true, createdAt: true },
                take: 200,
              }),
            ]);

            const totalCount = notifs.length + audits.length + secEvents.length;
            // Always send when enabled — even if quiet, user gets a summary of the period (per PRD: daily/weekly/monthly even without login/activity)
            {
              // Build notification items HTML — show last activity even when 0
              const itemsHtml = notifs.length > 0
                ? notifs.map(n =>
                    `<div style="padding:12px 14px;background:#111111;border:1px solid rgba(245,245,245,0.13);border-radius:10px;margin-bottom:8px;"><strong style="color:#F5F5F5;font-size:14px;">${esc(n.title)}</strong><br/><span style="color:rgba(245,245,245,0.74);font-size:13px;">${esc(n.body || '')}</span></div>`
                  ).join('')
                : '<p style="margin:0;font-size:14px;color:rgba(245,245,245,0.5);">No new notifications — everything is quiet. Here’s your activity for this period.</p>';

              // Build activity summary HTML — always show, even when 0
              const allEvents = [
                ...audits.map(a => ({ action: a.action, severity: a.severity, at: a.createdAt })),
                ...secEvents.map(s => ({ action: s.eventType, severity: s.severity, at: s.createdAt })),
              ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

              const activityCounts = new Map<string, number>();
              for (const e of allEvents) {
                const label = labelFor(e.action);
                activityCounts.set(label, (activityCounts.get(label) || 0) + 1);
              }

              const activityHtml = activityCounts.size > 0
                ? `<div style="margin-top:20px;">
                    <p style="margin:0 0 10px;font-size:14px;font-weight:600;color:#F5F5F5;">Activity Summary</p>
                    ${[...activityCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, n]) =>
                      `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(245,245,245,0.13);font-size:14px;color:rgba(245,245,245,0.74);"><span>${esc(label)}</span><strong style="color:#F5F5F5;">${n}</strong></div>`
                    ).join('')}
                    <div style="display:flex;justify-content:space-between;padding:10px 0 0;font-size:14px;color:#F5F5F5;"><span><strong>Total events</strong></span><strong>${allEvents.length}</strong></div>
                  </div>`
                : `<div style="margin-top:20px;padding:12px 14px;background:#111111;border-radius:10px;border:1px solid rgba(245,245,245,0.13);"><p style="margin:0;font-size:13px;color:rgba(245,245,245,0.5);">No account activity in this period — no logins, changes, or security events. We’ll keep watching.</p></div>`;

              const freqLabel = prefs.digestFrequency || 'daily';
              await sendTemplateEmail(u.email, 'notification_digest', {
                name: u.name || u.email,
                count: String(totalCount),
                digestItems: itemsHtml,
                activitySection: activityHtml,
                dashboardUrl,
              }, { rawVars: ['digestItems', 'activitySection'], categoryOverride: 'digest' }).catch(() => {});

              savePrefsSnapshot(u.id, { digestEnabled, digestFrequency: freqLabel, weeklySummary, lastDigestSentAt: now.toISOString(), lastWeeklySentAt: prefs.lastWeeklySentAt ?? null }).catch(() => {});

              console.log(`[DIGEST] Sent ${totalCount} items (${notifs.length} notifs + ${allEvents.length} activity) to ${u.email} (${freqLabel})`);
            }
          }
        }

        // ── 2. Activity summary (weeklySummary opt-in, user-chosen cadence) ──
        if (weeklySummary) {
          const summaryFreq = prefs.weeklySummaryFrequency || 'weekly';
          const periodMs = frequencyToMs(summaryFreq);
          if (isCadenceDue(prefs.lastWeeklySentAt, now, periodMs)) {
            const sent = await sendWeeklySummary(u.id, new Date(now.getTime() - periodMs), now, sendTemplateEmail, dashboardUrl);
            if (sent) {
              savePrefsSnapshot(u.id, { digestEnabled, digestFrequency: prefs.digestFrequency || 'daily', weeklySummary, weeklySummaryFrequency: summaryFreq, lastDigestSentAt: prefs.lastDigestSentAt ?? null, lastWeeklySentAt: now.toISOString() }).catch(() => {});
            }
          }
        }
      } catch (err: any) {
        console.error(`[DIGEST] Failed for user ${u.id}:`, err?.message);
      }
    }
  } catch (err: any) {
    console.error('[DIGEST] Error:', err?.message);
  }
}

/** Persist only the digest-related fields into the user jsonb column without overwriting other prefs. */
async function savePrefsSnapshot(userId: string, updates: Record<string, unknown>) {
  // Read current prefs, merge only the digest fields, write back
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPreferences: true } });
  const current = (user as any)?.notificationPreferences;
  const merged = (current && typeof current === 'object' && !Array.isArray(current)) ? { ...current } : {};
  Object.assign(merged, updates);
  await prisma.$executeRaw`UPDATE "users" SET "notification_preferences" = ${JSON.stringify(merged)}::jsonb WHERE "id" = ${userId}`;
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

/** Build & send one weekly activity summary email. Returns true when actually sent. */
export async function sendWeeklySummary(
  userId: string,
  since: Date,
  until: Date,
  sendTemplateEmailFn?: (to: string, t: string, v: Record<string, string>) => Promise<any>,
  dashboardUrlOverride?: string,
): Promise<boolean> {
  try {
    const [audits, security] = await Promise.all([
      prisma.auditEvent.findMany({
        where: { actorId: userId, createdAt: { gte: since, lte: until } },
        select: { action: true, severity: true },
        take: 500,
      }),
      prisma.securityEvent.findMany({
        where: { userId, createdAt: { gte: since, lte: until } },
        select: { eventType: true, severity: true },
        take: 500,
      }),
    ]);

    const total = audits.length + security.length;

    // Group by friendly label
    const counts = new Map<string, number>();
    let suspicious = 0;
    for (const e of [...audits.map(a => ({ ...a, src: 'a' })), ...security.map(s => ({ ...s, src: 's' }))]) {
      const action = 'action' in e ? e.action : (e as any).eventType;
      const label = labelFor(action);
      counts.set(label, (counts.get(label) || 0) + 1);
      const sev = String((e as any).severity || '').toLowerCase();
      const failed = /failed|locked|suspicious|denied/.test(String(action).toLowerCase());
      if (sev === 'warning' || sev === 'error' || sev === 'critical' || failed) suspicious++;
    }

    const statRows = counts.size === 0
      ? `<p style="margin:0;font-size:14px;color:rgba(245,245,245,0.5);">It was a quiet week — no account activity recorded.</p>`
      : [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 7)
          .map(([label, n]) =>
            `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(245,245,245,0.13);font-size:14px;color:rgba(245,245,245,0.74);"><span>${esc(label)}</span><strong style="color:#F5F5F5;">${n}</strong></div>`
          ).join('') +
          `<div style="display:flex;justify-content:space-between;padding:10px 0 0;font-size:14px;color:#F5F5F5;"><span><strong>Total events</strong></span><strong>${total}</strong></div>`;

    const suspiciousSection = suspicious > 0
      ? `<div style="margin:0 0 20px;padding:14px 18px;background:rgba(243,182,75,0.10);border-radius:10px;border:1px solid rgba(243,182,75,0.35);"><p style="margin:0;font-size:14px;line-height:22px;color:#F3B64B;"><strong>${suspicious} event${suspicious === 1 ? '' : 's'} need your attention</strong> — failed sign-ins or other security warnings. <a href="${dashboardUrlOverride}/activity/history" style="color:#F3B64B;text-decoration:underline;">Review them</a>.</p></div>`
      : '';

    const periodLabel = `${since.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${until.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!user?.email) return false;

    const send = sendTemplateEmailFn ?? (await import('@/features/email/email')).sendTemplateEmail;
    const dash = dashboardUrlOverride ?? (await import('@/config/app-urls')).getDashboardBaseUrl();
    const result = await (send as any)(user.email, 'weekly_summary', {
      name: user.name || user.email,
      periodLabel,
      statRows,
      suspiciousSection,
      dashboardUrl: dash,
    }, { categoryOverride: 'digest' }).catch(() => ({ success: false }));

    if (result?.success) console.log(`[WEEKLY] Summary (${total} events, ${suspicious} suspicious) → ${user.email}`);
    return !!result?.success;
  } catch (err: any) {
    console.error('[WEEKLY] Failed:', err?.message);
    return false;
  }
}

/** Start periodic digest sending. Checks every hour. */
let digestTimer: ReturnType<typeof setTimeout> | null = null;
export function startPeriodicDigests() {
  if (digestTimer) return;
  // Run once on startup after 60s, then every hour via setTimeout recursion
  setTimeout(() => { sendEmailDigests().catch(() => {}); }, 60_000);
  function scheduleDigest() {
    digestTimer = setTimeout(() => {
      sendEmailDigests().catch(() => {});
      scheduleDigest();
    }, 3_600_000);
  }
  scheduleDigest();
  console.log('[DIGEST] Periodic email digest started (hourly)');
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
// Rate-limited: one reactivation email per user per 30 days.

export async function sendReactivationEmails() {
  try {
    const cutoff7d = new Date(Date.now() - 7 * 86400_000);
    const cutoff30d = new Date(Date.now() - 30 * 86400_000);

    // Find users inactive for 7+ days who are eligible
    const users = await prisma.user.findMany({
      where: {
        deletedAt: null,
        isBanned: false,
        lastActiveAt: { lt: cutoff7d },
        // Must have opted into product/tips emails
        // We filter in JS below since it's a JSONB column
      },
      select: {
        id: true,
        email: true,
        name: true,
        lastActiveAt: true,
        createdAt: true,
        notificationPreferences: true,
      },
      take: 2000,
    });

    if (users.length === 0) return;

    const { sendTemplateEmail } = await import('@/features/email/email');
    const { getDashboardBaseUrl } = await import('@/config/app-urls');
    const dashboardUrl = getDashboardBaseUrl();

    // Check recent reactivation logs to avoid re-sending within 30 days
    const userIds = users.map(u => u.id);
    const recentLogs = await prisma.email_logs.findMany({
      where: {
        toEmail: { in: users.map(u => u.email) },
        template: 'reactivation',
        createdAt: { gt: cutoff30d },
      },
      select: { toEmail: true },
      distinct: ['toEmail'],
    }).catch(() => [] as any[]);
    const alreadySent = new Set(recentLogs.map(r => r.toEmail));

    let sentCount = 0;
    for (const u of users) {
      if (!u.email) continue;
      if (alreadySent.has(u.email)) continue;

      // Check notification preferences — reactivation emails are OPT-IN:
      // unset toggles mean no email (prevents mailing every inactive user).
      const prefs: any = (u as any).notificationPreferences;
      if (prefs && typeof prefs === 'object') {
        if (prefs.email === false) continue;
        // product category covers reactivation emails
        const productOn = prefs.product !== undefined ? prefs.product !== false : true;
        const productEmailOn = prefs.productEmail === true;
        if (!productOn || !productEmailOn) continue;
      } else {
        continue; // no prefs saved — don't email
      }

      // Calculate days since last active
      const lastActive = u.lastActiveAt ? new Date(u.lastActiveAt).getTime() : new Date(u.createdAt).getTime();
      const daysSince = Math.max(1, Math.floor((Date.now() - lastActive) / 86400_000));

      // Build a brief activity summary
      let activitySummary = '<p style="margin:0;font-size:14px;color:#64748b;">No recent activity recorded. Your workspace is waiting.</p>';
      try {
        const recentNotifs = await prisma.notification.findMany({
          where: { userId: u.id, createdAt: { gte: cutoff7d } },
          select: { title: true },
          take: 5,
        });
        if (recentNotifs.length > 0) {
          activitySummary = recentNotifs.map(n =>
            `<div style="padding:8px 14px;background:#111111;border-radius:8px;margin-bottom:6px;font-size:13px;color:#9a9a9a;">${esc(n.title)}</div>`
          ).join('');
        }
      } catch {}

      const result = await sendTemplateEmail(u.email, 'reactivation', {
        name: u.name || u.email,
        daysSince: String(daysSince),
        activitySummary,
        dashboardUrl,
      }, { rawVars: ['activitySummary'] }).catch(() => ({ success: false }));

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
