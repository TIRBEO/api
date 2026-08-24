import { prisma } from './db/prisma';

export type JobType = 'email' | 'webhook' | 'cleanup' | 'backup' | 'report' | 'sync' | string;

export async function createJob(type: JobType, payload: Record<string, unknown>, queue = 'default', maxAttempts = 3) {
  return prisma.jobs.create({
    data: { type, queue, payload: payload as any, maxAttempts, updatedAt: new Date() },
  });
}

export async function processNextJob(queue = 'default') {
  const job = await prisma.jobs.findFirst({
    where: { queue, status: 'pending' },
    orderBy: { createdAt: 'asc' },
  });
  if (!job) return null;

  await prisma.jobs.update({ where: { id: job.id }, data: { status: 'processing', startedAt: new Date(), attempts: job.attempts + 1 } });

  await prisma.job_attempts.create({
    data: { jobId: job.id, attempt: job.attempts + 1, status: 'processing', startedAt: new Date() },
  });

  return job;
}

export async function completeJob(jobId: string, result?: Record<string, unknown>) {
  await prisma.jobs.update({ where: { id: jobId }, data: { status: 'completed', completedAt: new Date(), payload: (result || {}) as any } });
  await prisma.job_attempts.updateMany({
    where: { jobId, status: 'processing' },
    data: { status: 'completed', completedAt: new Date() },
  });
}

export async function failJob(jobId: string, error: string) {
  const job = await prisma.jobs.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (job.attempts >= job.maxAttempts) {
    await prisma.jobs.update({ where: { id: jobId }, data: { status: 'failed', error, completedAt: new Date() } });
  } else {
    await prisma.jobs.update({ where: { id: jobId }, data: { status: 'pending', error } });
  }
  await prisma.job_attempts.updateMany({
    where: { jobId, status: 'processing' },
    data: { status: 'failed', error, completedAt: new Date() },
  });
}

export async function retryJob(jobId: string) {
  await prisma.jobs.update({ where: { id: jobId }, data: { status: 'pending', error: null, startedAt: null, completedAt: null, attempts: 0 } });
  await prisma.job_attempts.updateMany({ where: { jobId }, data: { status: 'cancelled' } });
}

export async function processQueue(queue = 'default', handler: (job: any) => Promise<void>) {
  const job = await processNextJob(queue);
  if (!job) return;
  try {
    await handler(job);
    await completeJob(job.id);
  } catch (err: any) {
    await failJob(job.id, err?.message || 'Unknown error');
  }
}

export async function cleanupOldJobs(olderThanDays = 30) {
  const cutoff = new Date(Date.now() - olderThanDays * 86400000);
  await prisma.jobs.deleteMany({ where: { createdAt: { lt: cutoff }, status: { in: ['completed', 'failed'] } } });
  await prisma.job_attempts.deleteMany({ where: { createdAt: { lt: cutoff } } });
}

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
export async function sendEmailDigests() {
  try {
    const prefs = await prisma.notificationPreference.findMany({
      where: { email: true, OR: [{ digestEnabled: true }, { weeklySummary: true }] },
      select: {
        userId: true,
        digestEnabled: true,
        digestFrequency: true,
        weeklySummary: true,
        lastDigestSentAt: true,
        lastWeeklySentAt: true,
      },
    });

    if (prefs.length === 0) return;

    const now = new Date();
    const { sendTemplateEmail } = await import('./email');
    const { getDashboardBaseUrl } = await import('./app-urls');
    const dashboardUrl = getDashboardBaseUrl();

    for (const p of prefs) {
      try {
        // ── 1. Unread-notifications digest ──
        if (p.digestEnabled) {
          const freqMs =
            p.digestFrequency === 'weekly' ? 7 * 86400000 :
            p.digestFrequency === 'monthly' ? 30 * 86400000 : 86400000;
          const lastSent = p.lastDigestSentAt ? new Date(p.lastDigestSentAt).getTime() : 0;

          if (now.getTime() - lastSent >= freqMs) {
            const cutoff = new Date(Math.max(lastSent, now.getTime() - freqMs));
            const notifs = await prisma.notification.findMany({
              where: { userId: p.userId, isRead: false, createdAt: { gte: cutoff } },
              orderBy: { createdAt: 'desc' },
              take: 50,
              select: { id: true, title: true, body: true, createdAt: true },
            });

            if (notifs.length > 0) {
              const user = await prisma.user.findUnique({ where: { id: p.userId }, select: { email: true, name: true } });
              if (user) {
                const itemsHtml = notifs.map(n =>
                  `<div style="padding:12px 16px;background:#f8f9fa;border-radius:8px;margin-bottom:8px;"><strong>${esc(n.title)}</strong><br/><span style="color:#666;font-size:13px;">${esc(n.body || '')}</span></div>`
                ).join('');

                await sendTemplateEmail(user.email, 'notification_digest', {
                  name: user.name || user.email,
                  count: String(notifs.length),
                  digestItems: itemsHtml,
                  dashboardUrl,
                }).catch(() => {});

                await prisma.notificationPreference.update({
                  where: { userId: p.userId },
                  data: { lastDigestSentAt: now },
                }).catch(() => {});

                console.log(`[DIGEST] Sent ${notifs.length} notifications to ${user.email} (${p.digestFrequency})`);
              }
            }
          }
        }

        // ── 2. Weekly activity summary ──
        if (p.weeklySummary) {
          const WEEK = 7 * 86400000;
          const lastWeekly = p.lastWeeklySentAt ? new Date(p.lastWeeklySentAt).getTime() : 0;
          if (now.getTime() - lastWeekly >= WEEK) {
            const sent = await sendWeeklySummary(p.userId, new Date(now.getTime() - WEEK), now, sendTemplateEmail, dashboardUrl);
            if (sent) {
              await prisma.notificationPreference.update({
                where: { userId: p.userId },
                data: { lastWeeklySentAt: now },
              }).catch(() => {});
            }
          }
        }
      } catch (err: any) {
        console.error(`[DIGEST] Failed for user ${p.userId}:`, err?.message);
      }
    }
  } catch (err: any) {
    console.error('[DIGEST] Error:', err?.message);
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

/**
 * Reconcile OAuth state so the DB is always self-consistent:
 *   user.{provider}Id  ←→  integration(provider)
 *  - linked user without an integration row → row created
 *  - integration row for a user WITHOUT the provider id (disconnected /
 *    transferred elsewhere) → row deleted outright
 */
export async function reconcileOauthLinks(): Promise<{ created: number; removed: number }> {
  let created = 0;
  let removed = 0;
  const providers: Array<'google' | 'github' | 'discord'> = ['google', 'github', 'discord'];
  try {
    const linkedUsers = await prisma.user.findMany({
      where: { OR: providers.map((p) => ({ [`${p}Id`]: { not: null } })) },
      select: { id: true, googleId: true, githubId: true, discordId: true },
    });

    const rows = await prisma.integration.findMany({
      where: { provider: { in: providers } },
      select: { id: true, userId: true, provider: true },
    });
    const rowKey = (userId: string, provider: string) => `${userId}:${provider}`;
    const existing = new Set(rows.map((r) => rowKey(r.userId, r.provider)));

    // 1) Missing rows for linked identities.
    if (linkedUsers.length) {
      const missing: Array<{ userId: string; provider: string; connected: boolean; metadata: Record<string, string> }> = [];
      for (const u of linkedUsers) {
        for (const p of providers) {
          const pid = (u as any)[`${p}Id`] as string | null;
          if (pid && !existing.has(rowKey(u.id, p))) {
            missing.push({ userId: u.id, provider: p, connected: true, metadata: { [`${p}Id`]: pid } });
          }
        }
      }
      if (missing.length) {
        await prisma.integration.createMany({ data: missing as any });
        created = missing.length;
        missing.forEach((m) => existing.add(rowKey(m.userId, m.provider)));
      }
    }

    // 2) Rows whose identity no longer lives on the user → hard delete.
    const linkedIds = new Set(linkedUsers.map((u) => u.id));
    const orphanIds = rows
      .filter((r) => !linkedIds.has(r.userId) || !(linkedUsers.find((u) => u.id === r.userId) as any)?.[`${r.provider}Id`])
      .map((r) => r.id);
    if (orphanIds.length) {
      await prisma.integration.deleteMany({ where: { id: { in: orphanIds } } });
      removed = orphanIds.length;
    }

    if (created || removed) console.log(`[OAUTH-SYNC] Reconciled: ${created} integration row(s) created, ${removed} deleted`);
    return { created, removed };
  } catch (err: any) {
    console.error('[OAUTH-SYNC] Failed:', err?.message);
    return { created, removed };
  }
}

/** Start periodic OAuth reconciliation — every 10 minutes. */
let oauthSyncInterval: ReturnType<typeof setInterval> | null = null;
export function startPeriodicOauthSync() {
  if (oauthSyncInterval) return;
  setTimeout(() => { reconcileOauthLinks(); }, 45_000);
  oauthSyncInterval = setInterval(() => { reconcileOauthLinks(); }, 600_000);
  console.log('[OAUTH-SYNC] Periodic link reconciliation started (every 10 min)');
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
        prisma.refresh_tokens.deleteMany({ where: { userId: user.id } }),
        prisma.apiKey.deleteMany({ where: { userId: user.id } }),
        prisma.notification.deleteMany({ where: { userId: user.id } }),
        prisma.pushSubscription.deleteMany({ where: { userId: user.id } }),
        prisma.otp.deleteMany({ where: { userId: user.id } }),
        prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
        prisma.notificationPreference.deleteMany({ where: { userId: user.id } }),
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
