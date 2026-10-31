import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized, cronUnauthorized } from '../_guard';
import { JOB_DEFS, runSingleJobIfDue } from '@/jobs/job-gate';
import type { JobName } from '@/jobs/job-gate';

/* Single-job trigger — the Cloudflare queue consumer (apps/jobs) calls this
   once per scheduled fire. The gate (`job_runs` intervals + in-process lock)
   makes it safe to call as often as you like: a not-due job answers
   { ran: false } cheaply. Auth is Bearer CRON_SECRET (or a platform cron). */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const JOBS = new Set<string>(JOB_DEFS.map(([n]) => n));

export async function POST(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  let job = '';
  try {
    const body = await request.json();
    job = String(body?.job || '');
  } catch {
    return NextResponse.json({ error: 'Body must be JSON: { "job": "<name>" }' }, { status: 400 });
  }
  if (!JOBS.has(job)) {
    return NextResponse.json({ error: `Unknown job. Valid: ${[...JOBS].join(', ')}` }, { status: 400 });
  }

  const result = await runSingleJobIfDue(job as JobName);
  console.log(`[CRON/RUN] ${job} → ${JSON.stringify(result).slice(0, 120)}`);
  return NextResponse.json({ job, ...result });
}
