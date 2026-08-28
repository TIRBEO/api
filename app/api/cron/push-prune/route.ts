import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get('authorization') || '';
  return auth === `Bearer ${secret}` || req.headers.get('x-vercel-cron') === '1';
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { pruneStalePushSubscriptions } = await import('@/lib/push-notifications');
    const pruned = await pruneStalePushSubscriptions(60);
    return NextResponse.json({ ok: true, pruned, at: new Date().toISOString() });
  } catch (e: any) {
    console.error('[CRON push-prune]', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
export async function POST(req: NextRequest) { return GET(req); }
