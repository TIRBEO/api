import { NextRequest, NextResponse } from 'next/server';

/* Single-job trigger — the Cloudflare queue consumer (apps/jobs) calls this
   once per scheduled fire. The gate (`job_runs` intervals + in-process lock)
   makes it safe to call as often as you like: a not-due job answers
   { ran: false } cheaply. Auth is Bearer CRON_SECRET (or a platform cron).

   Auth and job lookup are deliberately self-contained / lazy: Vercel's static
   route-config analyzer rejects any module shape it can misread as config
   (shared guard imports, module-level Sets), which silently turned this route
   into a 404 in production while local builds passed. */

export const runtime = 'nodejs';

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req: NextRequest): boolean {
  const vercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
  if (vercel && req.headers.get('x-vercel-cron') === '1') return true;
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return false;
  return constantTimeEquals(req.headers.get('authorization') || '', `Bearer ${secret}`);
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let job = '';
  try {
    const body = await request.json();
    job = String(body?.job || '');
  } catch {
    return NextResponse.json({ error: 'Body must be JSON: { "job": "<name>" }' }, { status: 400 });
  }

  const { runSingleJobIfDue } = await import('@/jobs/job-gate');
  const result = await runSingleJobIfDue(job as any);
  console.log(`[CRON/RUN] ${job} → ${JSON.stringify(result).slice(0, 120)}`);
  return NextResponse.json({ job, ...result });
}
