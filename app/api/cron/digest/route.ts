import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // allow if not configured (dev)
  const auth = req.headers.get('authorization') || '';
  return auth === `Bearer ${secret}` || req.headers.get('x-vercel-cron') === '1';
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { sendEmailDigests } = await import('@/lib/jobs');
    await sendEmailDigests();
    return NextResponse.json({ ok: true, at: new Date().toISOString() });
  } catch (e: any) {
    console.error('[CRON digest]', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
export async function POST(req: NextRequest) { return GET(req); }
