import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Deprecated — unified into /api/cron. Requires the same CRON auth.
export async function GET(request: NextRequest) {
  const { isCronAuthorized, cronUnauthorized } = await import('../_guard');
  if (!isCronAuthorized(request)) return cronUnauthorized();

  const { runDueJobs } = await import('@/jobs/job-gate');
  const results = await runDueJobs();
  return NextResponse.json({ ok: true, deprecated: true, use: '/api/cron', results });
}

export async function POST(request: NextRequest) { return GET(request); }