import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Deprecated — unified into /api/cron. Kept for backwards compat.
export async function GET(req: NextRequest) {
  const { runDueJobs } = await import('@/jobs/job-gate');
  const results = await runDueJobs();
  return NextResponse.json({ ok: true, deprecated: true, use: '/api/cron', results });
}
export async function POST(req: NextRequest) { return GET(req); }
