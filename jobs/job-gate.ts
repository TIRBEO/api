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
  | 'recap'
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
  recap:             23 * 3600_000,  // ~daily (cron runs daily; gate allows slightly less)
  weekly_summary:    6 * 86400_000,  // weekly
  permanent_deletion: 23 * 3600_000, // daily
  deletion_sweep:    23 * 3600_000,  // daily
  push_prune:        23 * 3600_000,  // daily
  reactivation:      23 * 3600_000,  // ~daily
  tips:              23 * 3600_000,  // ~daily
  cdn_purge:         23 * 3600_000,  // ~daily — CDN trash + self-destruct sweep
};

// ─── Gate helpers (use prisma_raw to avoid needing a model for a simple table) ───

/** The gate's own state table has to exist before the gate can read it, so the
 *  DDL rides along with every check. Once per process is enough: a
 *  `CREATE TABLE IF NOT EXISTS` against a table that is already there costs a
 *  round trip and nothing else, and this runs on the request path.
 *
 *  A failure clears the memo so the next request retries — a cold start that
 *  lost the database for one second must not leave this process permanently
 *  unable to run its jobs. */
let tableReady: Promise<void> | null = null;
async function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "public"."job_runs" (
        job_name TEXT PRIMARY KEY,
        last_run TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_duration_ms INT DEFAULT 0,
        last_status TEXT DEFAULT 'ok',
        run_count INT DEFAULT 0
      )
    `).then(() => {}).catch(() => { tableReady = null; });
  }
  await tableReady;
}

/** Every job's last run, in one read. Asked per job that is 7 sequential
 *  queries on every request that reaches the gate, and a job that is not due
 *  (nearly always, on a 23h interval) answers with the same empty result each
 *  time. */
async function lastRuns(): Promise<Record<string, number>> {
  await ensureTable();
  try {
    const rows = await prisma.$queryRawUnsafe<{ job_name: string; last_run: string }[]>(
      `SELECT job_name, last_run FROM "public"."job_runs"`);
    const out: Record<string, number> = {};
    for (const row of rows) out[row.job_name] = new Date(row.last_run).getTime();
    return out;
  } catch {
    return {}; // unreadable counts as never run, which is what the old per-job read returned
  }
}

/** Claim a job for this process. The claim IS the due check: the row only moves
 *  for a caller whose `last_run` is still older than the interval, so two
 *  instances that wake at the same minute cannot both take the same job —
 *  which the old in-memory lock could not promise, since a lock in one
 *  serverless instance says nothing about the next one. */
async function claimJob(job: JobName, runs: Record<string, number>): Promise<boolean> {
  await ensureTable();
  const intervalMs = JOB_INTERVALS[job];
  const known = Object.prototype.hasOwnProperty.call(runs, job);
  if (known && Date.now() - runs[job] <= intervalMs) return false; // not due, no write needed
  try {
    if (!known) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "public"."job_runs" (job_name, last_run, last_status) VALUES ($1, NOW() - $2::bigint * interval '1 millisecond', 'queued')
         ON CONFLICT (job_name) DO NOTHING`, job, intervalMs);
    }
    const taken = await prisma.$executeRawUnsafe(
      `UPDATE "public"."job_runs" SET last_run = NOW(), last_status = 'running'
       WHERE job_name = $1 AND last_run < NOW() - $2::bigint * interval '1 millisecond'`,
      job, intervalMs);
    return taken === 1;
  } catch {
    return false;
  }
}

async function recordRun(job: JobName, durationMs: number, status: string) {
  await ensureTable();
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "public"."job_runs" (job_name, last_run, last_duration_ms, last_status, run_count)
      VALUES ($1, NOW(), $2, $3, 1)
      ON CONFLICT (job_name) DO UPDATE SET
        last_run = NOW(),
        last_duration_ms = EXCLUDED.last_duration_ms,
        last_status = EXCLUDED.last_status,
        run_count = "public"."job_runs".run_count + 1
    `, job, Math.round(durationMs), status);
  } catch {}
}

// ─── Public API ───

/**
 * Returns true if the job is due (last run > interval ago).
 * Safe to call from any request — one DB read for the whole table.
 */
export async function isJobDue(job: JobName): Promise<boolean> {
  const runs = await lastRuns();
  return Date.now() - (runs[job] ?? 0) > JOB_INTERVALS[job];
}

/**
 * Run a job if it's due and claimable. Returns { ran, duration?, error? }.
 */
export async function runJobIfDue(
  job: JobName,
  fn: () => Promise<void>,
  runs?: Record<string, number>
): Promise<{ ran: boolean; duration?: number; error?: string }> {
  const lockKey = `__job_lock_${job}`;
  const g = globalThis as any;
  if (g[lockKey]) return { ran: false }; // already running here

  if (!(await claimJob(job, runs ?? await lastRuns()))) return { ran: false };

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
  // One read for the whole sweep, so a request that runs no jobs costs one
  // query rather than one per job.
  const runs = await lastRuns();

  const jobDefs: [JobName, () => Promise<void>][] = [
    /* Deletion first, on purpose. The run has an 8-second budget before this
       process would be cut off, and the job behind it used to sit third —
       after two mail jobs that send one message per account — so a night with
       anything to say starved the sweep entirely: accounts whose 30 days were
       up stayed `deletion_pending` with the screen still promising them a date.
       The one job that cannot be undone is the one that must not be queued. */
    ['permanent_deletion', async () => {
      const m = await import('@/jobs/jobs-permanent-deletion');
      await m.permanentDeletionJob();
    }],
    ['deletion_sweep', async () => {
      const { processScheduledDeletions } = await import('@/features/users/userHandlers');
      await processScheduledDeletions();
    }],
    ['cleanup', async () => {
      const { cleanupOldNotifications } = await import('@/jobs/jobs');
      await cleanupOldNotifications();
    }],
    ['recap', async () => {
      const { sendAccountSummaries } = await import('@/jobs/jobs');
      await sendAccountSummaries();
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
  ];

  for (const [job, fn] of jobDefs) {
    if (Date.now() > deadline) {
      results.push({ job, ran: false });
      continue;
    }
    const r = await runJobIfDue(job, fn, runs);
    results.push({ job, ...r });
  }

  return results;
}

/**
 * The sweep for callers that sit on the request path.
 *
 * A request is not a scheduler. Every job here runs on a 12–23 hour interval,
 * so asking the database "is anything due" more than once every few minutes per
 * instance cannot change the answer — it only takes a connection from the pool
 * the request itself is waiting on. The stamp is set before the sweep starts, so
 * two requests in the same millisecond do not both go.
 *
 * The cron routes call `runDueJobs` directly and are never gated by this.
 */
let lastRequestSweepAt = 0;
const REQUEST_SWEEP_EVERY_MS = 5 * 60 * 1000;

export async function runDueJobsFromRequest(): Promise<{ job: string; ran: boolean; duration?: number; error?: string }[]> {
  const now = Date.now();
  if (now - lastRequestSweepAt < REQUEST_SWEEP_EVERY_MS) return [];
  lastRequestSweepAt = now;
  return runDueJobs();
}
