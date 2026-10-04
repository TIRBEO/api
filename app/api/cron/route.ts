import { NextRequest, NextResponse } from 'next/server';
import { runDueJobs } from '@/jobs/job-gate';
import { isCronAuthorized, cronUnauthorized } from './_guard';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  console.log('[CRON] Starting due jobs...');
  const results = await runDueJobs();
  const ran = results.filter(r => r.ran);
  console.log(`[CRON] Done. ${ran.length}/${results.length} jobs ran.`);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    total: results.length,
    ran: ran.length,
    results,
  });
}

export async function POST(request: NextRequest) {
  return GET(request);
}