import { NextRequest, NextResponse } from 'next/server';
import { JOB_DEFS, runSingleJobIfDue } from '@/jobs/job-gate';
import type { JobName } from '@/jobs/job-gate';
import { isCronAuthorized, cronUnauthorized } from '../_guard';

export const runtime = 'nodejs';

/* Single-job trigger — the Cloudflare queue consumer (apps/jobs) calls this
   once per scheduled fire. The gate (`job_runs` intervals + in-process lock)
   keeps it idempotent, so a queue redelivery or a stray manual curl cannot
   double-run anything; a not-due job answers { ran: false } cheaply. Auth is
   the same guard as /api/cron: Vercel's header or Bearer ${CRON_SECRET}. */

const JOBS = new Set(JOB_DEFS.map(([name]) => name));

export async function POST(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  let job = '';
  try {
    const body = await request.json();
    job = String(body?.job || '');
  } catch {
    return NextResponse.json({ error: 'Body must be JSON: { "job": "<name>" }' }, { status: 400 });
  }
  if (!JOBS.has(job as JobName)) {
    return NextResponse.json({ error: `Unknown job. Valid: ${[...JOBS].join(', ')}` }, { status: 400 });
  }

  const result = await runSingleJobIfDue(job as JobName);
  console.log(`[CRON/RUN] ${job} → ${JSON.stringify(result).slice(0, 120)}`);
  return NextResponse.json({ job, ...result });
}
