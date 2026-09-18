/**
 * /api/cron — Vercel Cron Job endpoint.
 *
 * On Vercel free tier: 1 cron job/day (configurable in vercel.json).
 * This endpoint runs all due background jobs (digests, cleanup, tips, etc.).
 *
 * Security: only callable by Vercel Cron (VERCEL_CRON_SECRET) or with a
 * manual CRON_SECRET bearer token.
 */
import { NextRequest, NextResponse } from 'next/server';
import { runDueJobs } from '@/jobs/job-gate';

export async function GET(request: NextRequest) {
  // Verify caller: Vercel Cron or manual secret
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const vercelCron = request.headers.get('x-vercel-cron');

  if (cronSecret && vercelCron !== '1' && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
