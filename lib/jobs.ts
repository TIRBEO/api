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
}

/**
 * Send email digests based on user preferences.
 * Checks each user's digestFrequency (daily/weekly/monthly)
 * and sends a batched email of unread notifications.
 */
export async function sendEmailDigests() {
  try {
    const prefs = await prisma.notificationPreference.findMany({
      where: { emailEnabled: true, digestEnabled: true },
      select: { userId: true, digestFrequency: true },
    });

    if (prefs.length === 0) return;

    const now = new Date();
    const { sendTemplateEmail } = await import('./email');
    const { getDashboardBaseUrl } = await import('./app-urls');
    const dashboardUrl = getDashboardBaseUrl();

    for (const p of prefs) {
      try {
        // Determine the cutoff based on frequency
        let cutoff: Date;
        switch (p.digestFrequency) {
          case 'weekly':
            cutoff = new Date(now.getTime() - 7 * 86400000);
            break;
          case 'monthly':
            cutoff = new Date(now.getTime() - 30 * 86400000);
            break;
          default: // daily
            cutoff = new Date(now.getTime() - 86400000);
            break;
        }

        // Get unread notifications since last digest
        const notifs = await prisma.notification.findMany({
          where: {
            userId: p.userId,
            isRead: false,
            createdAt: { gte: cutoff },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { id: true, title: true, body: true, createdAt: true },
        });

        if (notifs.length === 0) continue;

        const user = await prisma.user.findUnique({
          where: { id: p.userId },
          select: { email: true, name: true },
        });
        if (!user) continue;

        // Build digest items HTML
        const itemsHtml = notifs.map(n =>
          `<div style="padding:12px 16px;background:#f8f9fa;border-radius:8px;margin-bottom:8px;"><strong>${n.title}</strong><br/><span style="color:#666;font-size:13px;">${n.body || ''}</span></div>`
        ).join('');

        await sendTemplateEmail(user.email, 'notification_digest', {
          name: user.name || user.email,
          count: String(notifs.length),
          digestItems: itemsHtml,
          dashboardUrl,
        }).catch(() => {});

        console.log(`[DIGEST] Sent ${notifs.length} notifications to ${user.email} (${p.digestFrequency})`);
      } catch (err: any) {
        console.error(`[DIGEST] Failed for user ${p.userId}:`, err?.message);
      }
    }
  } catch (err: any) {
    console.error('[DIGEST] Error:', err?.message);
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
