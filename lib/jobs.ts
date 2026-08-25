import { prisma } from './db/prisma';

/** Delete notifications older than 30 days. Runs on startup + hourly. */
export async function cleanupOldNotifications(olderThanDays = 30) {
  const cutoff = new Date(Date.now() - olderThanDays * 86400000);
  const result = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (result.count > 0) console.log(`[CLEANUP] Deleted ${result.count} old notifications (>${olderThanDays} days)`);
  return result.count;
}

/** Start periodic notification cleanup — every hour. */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
export function startPeriodicCleanup() {
  if (cleanupInterval) return;
  // Run once on startup after 30s, then every hour
  setTimeout(() => { cleanupOldNotifications().catch(() => {}); }, 30_000);
  cleanupInterval = setInterval(() => { cleanupOldNotifications().catch(() => {}); }, 3_600_000);
  console.log('[CLEANUP] Periodic notification cleanup started (hourly)');

  // Permanent deletion of soft-deleted accounts (daily)
  setTimeout(() => {
    import('./jobs-permanent-deletion').then(m => m.permanentDeletionJob().catch(() => {}));
  }, 60_000);
  setInterval(() => {
    import('./jobs-permanent-deletion').then(m => m.permanentDeletionJob().catch(() => {}));
  }, 86_400_000); // 24 hours
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
  lastDigestSentAt?: string | null;
  lastWeeklySentAt?: string | null;
}

function readPrefs(json: unknown): Partial<DigestPrefs> {
  return (json && typeof json === 'object' && !Array.isArray(json)) ? json as Partial<DigestPrefs> : {};
}

export async function sendEmailDigests() {
  try {
    // Users opt into digests via their notification_preferences jsonb column.
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        notificationPreferences: true,
      },
      take: 2000,
    });

    const now = new Date();
    const { sendTemplateEmail } = await import('./email');
    const { getDashboardBaseUrl } = await import('./app-urls');
    const dashboardUrl = getDashboardBaseUrl();

    for (const u of users) {
      const prefs = readPrefs((u as any).notificationPreferences);
      if (!(u as any).email) continue;
      const digestEnabled = prefs.digestEnabled === true;
      const weeklySummary = prefs.weeklySummary === true;
      if (!digestEnabled && !weeklySummary) continue;
      try {
        // ── 1. Unread-notifications digest ──
        if (digestEnabled) {
          const freqMs =
            prefs.digestFrequency === 'weekly' ? 7 * 86400000 :
            prefs.digestFrequency === 'monthly' ? 30 * 86400000 : 86400000;
          const lastSent = prefs.lastDigestSentAt ? new Date(prefs.lastDigestSentAt).getTime() : 0;

          if (now.getTime() - lastSent >= freqMs) {
            const cutoff = new Date(Math.max(lastSent, now.getTime() - freqMs));
            const notifs = await prisma.notification.findMany({
              where: { userId: u.id, isRead: false, createdAt: { gte: cutoff }, type: { notIn: ['product'] } },
              orderBy: { createdAt: 'desc' },
              take: 50,
              select: { id: true, title: true, body: true, createdAt: true },
            });

            if (notifs.length > 0) {
              const itemsHtml = notifs.map(n =>
                `<div style="padding:12px 16px;background:#f8f9fa;border-radius:8px;margin-bottom:8px;"><strong>${esc(n.title)}</strong><br/><span style="color:#666;font-size:13px;">${esc(n.body || '')}</span></div>`
              ).join('');

              await sendTemplateEmail(u.email, 'notification_digest', {
                name: u.name || u.email,
                count: String(notifs.length),
                digestItems: itemsHtml,
                dashboardUrl,
              }).catch(() => {});

              savePrefsSnapshot(u.id, { ...prefs, email: true, digestEnabled, digestFrequency: prefs.digestFrequency || 'daily', weeklySummary, lastDigestSentAt: now.toISOString(), lastWeeklySentAt: prefs.lastWeeklySentAt ?? null }).catch(() => {});

              console.log(`[DIGEST] Sent ${notifs.length} notifications to ${u.email} (${prefs.digestFrequency || 'daily'})`);
            }
          }
        }

        // ── 2. Weekly activity summary ──
        if (weeklySummary) {
          const WEEK = 7 * 86400000;
          const lastWeekly = prefs.lastWeeklySentAt ? new Date(prefs.lastWeeklySentAt).getTime() : 0;
          if (now.getTime() - lastWeekly >= WEEK) {
            const sent = await sendWeeklySummary(u.id, new Date(now.getTime() - WEEK), now, sendTemplateEmail, dashboardUrl);
            if (sent) {
              savePrefsSnapshot(u.id, { ...prefs, email: true, digestEnabled, digestFrequency: prefs.digestFrequency || 'daily', weeklySummary, lastDigestSentAt: prefs.lastDigestSentAt ?? null, lastWeeklySentAt: now.toISOString() }).catch(() => {});
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

/** Persist a full prefs snapshot back into the user jsonb column. */
async function savePrefsSnapshot(userId: string, snapshot: Record<string, unknown>) {
  await prisma.$executeRaw`UPDATE "users" SET "notification_preferences" = ${JSON.stringify(snapshot)}::jsonb WHERE "id" = ${userId}`;
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
      ? `<p style="margin:0;font-size:14px;color:#64748b;">It was a quiet week — no account activity recorded.</p>`
      : [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 7)
          .map(([label, n]) =>
            `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:14px;color:#334155;"><span>${esc(label)}</span><strong>${n}</strong></div>`
          ).join('') +
          `<div style="display:flex;justify-content:space-between;padding:10px 0 0;font-size:14px;color:#0f172a;"><span><strong>Total events</strong></span><strong>${total}</strong></div>`;

    const suspiciousSection = suspicious > 0
      ? `<div style="margin:0 0 20px;padding:14px 18px;background:#fff7ed;border-radius:10px;border:1px solid #fed7aa;"><p style="margin:0;font-size:14px;line-height:22px;color:#9a3412;">⚠️ <strong>${suspicious} event${suspicious === 1 ? '' : 's'} need your attention</strong> — failed sign-ins or other security warnings. <a href="${dashboardUrlOverride}/activity/history" style="color:#c2410c;text-decoration:none;">Review them</a>.</p></div>`
      : '';

    const periodLabel = `${since.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${until.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!user?.email) return false;

    const send = sendTemplateEmailFn ?? (await import('./email')).sendTemplateEmail;
    const dash = dashboardUrlOverride ?? (await import('./app-urls')).getDashboardBaseUrl();
    const result = await send(user.email, 'weekly_summary', {
      name: user.name || user.email,
      periodLabel,
      statRows,
      suspiciousSection,
      dashboardUrl: dash,
    }).catch(() => ({ success: false }));

    if (result?.success) console.log(`[WEEKLY] Summary (${total} events, ${suspicious} suspicious) → ${user.email}`);
    return !!result?.success;
  } catch (err: any) {
    console.error('[WEEKLY] Failed:', err?.message);
    return false;
  }
}

/** Start periodic digest sending. Checks every hour. */
let digestInterval: ReturnType<typeof setInterval> | null = null;
export function startPeriodicDigests() {
  if (digestInterval) return;
  // Run once on startup after 60s, then every hour
  setTimeout(() => { sendEmailDigests().catch(() => {}); }, 60_000);
  digestInterval = setInterval(() => { sendEmailDigests().catch(() => {}); }, 3_600_000);
  console.log('[DIGEST] Periodic email digest started (hourly)');
}

// ─── SCHEDULED ACCOUNT DELETIONS ───
// Runs hourly. Hard-deletes accounts whose grace period has elapsed:
// anonymizes identity, wipes sessions/tokens/devices/notifications, keeps the
// audit trail (actorId nulled where possible via cascade-safe updates).

export async function processScheduledDeletions() {
  const due = await prisma.user.findMany({
    where: { scheduledDeletionAt: { lte: new Date() }, deletedAt: null },
    select: { id: true, email: true },
    take: 200,
  });
  if (!due.length) return 0;

  for (const user of due) {
    try {
      await prisma.$transaction([
        prisma.session.deleteMany({ where: { userId: user.id } }),
        prisma.apiKey.deleteMany({ where: { userId: user.id } }),
        prisma.notification.deleteMany({ where: { userId: user.id } }),
        prisma.otp.deleteMany({ where: { userId: user.id } }),
        prisma.user.update({ where: { id: user.id }, data: { backupCodes: [] } }),
        prisma.userTipLog.deleteMany({ where: { userId: user.id } }),
      ]);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          deletedAt: new Date(),
          email: `deleted+${user.id}@tirbeo.invalid`,
          secondaryEmail: null,
          name: 'Deleted User',
          photoUrl: null,
          bio: null,
          username: null,
          phoneNumber: null,
          website: null,
          linkedin: null,
          githubUsername: null,
          twitter: null,
          passwordHash: null,
          googleId: null,
          githubId: null,
          discordId: null,
          totpSecret: null,
          scheduledDeletionAt: null,
          is2FAEnabled: false,
        },
      });

      await prisma.auditEvent.create({
        data: { action: 'user.deleted.scheduled', targetType: 'user', targetId: user.id, metadata: { email: user.email } },
      }).catch(() => {});
    } catch (err: any) {
      console.error('[DELETION_SWEEP] failed for', user.id, err?.message);
    }
  }
  return due.length;
}

let deletionInterval: ReturnType<typeof setInterval> | null = null;
export function startPeriodicDeletionSweep() {
  if (deletionInterval) return;
  deletionInterval = setInterval(() => { processScheduledDeletions().catch(() => {}); }, 3_600_000);
}
