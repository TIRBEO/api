/**
 * Job Gate — on-demand periodic job runner for serverless (Vercel free tier).
 *
 * On Vercel there are no setInterval timers. Instead:
 *  1. A single Vercel Cron Job hits /api/cron every day
 *  2. Each API request also checks if any jobs are due (lightweight gate check)
 *  3. Job run timestamps are stored in a DB table to survive cold starts
 *
 * Gate intervals are deliberately generous — free-tier Vercel functions
 * have 10s hobby / 60s pro execution limits, so we batch work and bail early.
 */
import { prisma } from '@/infrastructure/db/prisma';

// ─── Types ───
export type JobName =
  | 'cleanup'
  | 'digest'
  | 'weekly_summary'
  | 'permanent_deletion'
  | 'deletion_sweep'
  | 'push_prune'
  | 'reactivation'
  | 'tips'
  | 'cdn_purge';

// How often each job is allowed to run (ms)
const JOB_INTERVALS: Record<JobName, number> = {
  cleanup:           12 * 3600_000,  // every 12h
  digest:            23 * 3600_000,  // ~daily (cron runs daily; gate allows slightly less)
  weekly_summary:    6 * 86400_000,  // weekly
  permanent_deletion: 23 * 3600_000, // daily
  deletion_sweep:    23 * 3600_000,  // daily
  push_prune:        23 * 3600_000,  // daily
  reactivation:      23 * 3600_000,  // ~daily
  tips:              23 * 3600_000,  // ~daily
  cdn_purge:         23 * 3600_000,  // ~daily — CDN trash + self-destruct sweep
};

// ─── Gate helpers (use prisma_raw to avoid needing a model for a simple table) ───

async function ensureTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS job_runs (
      job_name TEXT PRIMARY KEY,
      last_run TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_duration_ms INT DEFAULT 0,
      last_status TEXT DEFAULT 'ok',
      run_count INT DEFAULT 0
    )
  `).catch(() => {});
}

async function getLastRun(job: JobName): Promise<number> {
  await ensureTable();
  try {
    const rows = await prisma.$queryRawUnsafe<{ last_run: string }[]>(
      `SELECT last_run FROM job_runs WHERE job_name = $1`, job
    );
    if (rows.length === 0) return 0;
    return new Date(rows[0].last_run).getTime();
  } catch {
    return 0;
  }
}

async function recordRun(job: JobName, durationMs: number, status: string) {
  await ensureTable();
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO job_runs (job_name, last_run, last_duration_ms, last_status, run_count)
      VALUES ($1, NOW(), $2, $3, 1)
      ON CONFLICT (job_name) DO UPDATE SET
        last_run = NOW(),
        last_duration_ms = EXCLUDED.last_duration_ms,
        last_status = EXCLUDED.last_status,
        run_count = job_runs.run_count + 1
    `, job, Math.round(durationMs), status);
  } catch {}
}

// ─── Public API ───

/**
 * Returns true if the job is due (last run > interval ago).
 * Safe to call from any request — just a DB read.
 */
export async function isJobDue(job: JobName): Promise<boolean> {
  const lastRun = await getLastRun(job);
  const interval = JOB_INTERVALS[job];
  return Date.now() - lastRun > interval;
}

/**
 * Run a job if it's due. Skips if already running (simple in-memory lock).
 * Returns { ran: boolean, duration?: number }
 */
export async function runJobIfDue(
  job: JobName,
  fn: () => Promise<void>
): Promise<{ ran: boolean; duration?: number; error?: string }> {
  const lockKey = `__job_lock_${job}`;
  const g = globalThis as any;
  if (g[lockKey]) return { ran: false }; // already running

  const due = await isJobDue(job);
  if (!due) return { ran: false };

  g[lockKey] = true;
  const start = performance.now();
  try {
    await fn();
    const duration = performance.now() - start;
    await recordRun(job, duration, 'ok');
    return { ran: true, duration };
  } catch (err: any) {
    const duration = performance.now() - start;
    await recordRun(job, duration, `error: ${err?.message?.slice(0, 200) || 'unknown'}`);
    return { ran: true, duration, error: err?.message };
  } finally {
    g[lockKey] = false;
  }
}

/**
 * Run ALL due jobs. Called from /api/cron and optionally from a middleware gate.
 * Bails early if execution is approaching Vercel's timeout (8s safe margin for hobby).
 */
export async function runDueJobs(): Promise<{ job: string; ran: boolean; duration?: number; error?: string }[]> {
  const results: { job: string; ran: boolean; duration?: number; error?: string }[] = [];
  const deadline = Date.now() + 8_000; // 8s budget for hobby tier

  const jobDefs: [JobName, () => Promise<void>][] = [
    ['cleanup', async () => {
      const { cleanupOldNotifications } = await import('@/jobs/jobs');
      await cleanupOldNotifications();
    }],
    ['digest', async () => {
      const { sendEmailDigests } = await import('@/jobs/jobs');
      await sendEmailDigests();
    }],
    ['permanent_deletion', async () => {
      const m = await import('@/jobs/jobs-permanent-deletion');
      await m.permanentDeletionJob();
    }],
    ['deletion_sweep', async () => {
      const { processScheduledDeletions } = await import('@/features/users/userHandlers');
      await processScheduledDeletions();
    }],
    ['push_prune', async () => {
      const m = await import('@/infrastructure/push/push-notifications');
      await m.pruneStalePushSubscriptions();
    }],
    ['reactivation', async () => {
      const { sendReactivationEmails } = await import('@/jobs/jobs');
      await sendReactivationEmails();
    }],
    ['tips', async () => {
      const m = await import('@/features/users/tips');
      await m.runAutoTipsSweep();
    }],
    ['cdn_purge', async () => {
      const { purgeAllExpiredTrash, selfDestructSweep, purgeExpiredShareLinks } = await import('@/features/media/cdnStorage');
      await purgeAllExpiredTrash();
      await selfDestructSweep();
      await purgeExpiredShareLinks();
    }],
  ];

  for (const [job, fn] of jobDefs) {
    if (Date.now() > deadline) {
      results.push({ job, ran: false });
      continue;
    }
    const r = await runJobIfDue(job, fn);
    results.push({ job, ...r });
  }

  return results;
}
