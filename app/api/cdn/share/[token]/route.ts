import { NextRequest, NextResponse } from 'next/server';
import { redeemShareLink, peekShareLink, getShareLinkRecord } from '@/features/media/cdnStorage';
import { isCockroachHealthy } from '@/infrastructure/db/cockroach';

export const runtime = 'nodejs';

/**
 * Company CDN one-time share links:
 *
 * GET  /api/cdn/share/[token] — NON-destructive status check. Returns the
 *      link's metadata + whether it's still redeemable, but NEVER flips the
 *      redeemed flag. Link previews (Slack/Discord/iMessage), prefetches, and
 *      scanners hit this safely — they can no longer burn the single open.
 *
 * POST /api/cdn/share/[token] — the actual atomic redeem. Only an explicit
 *      user action ("Open file") calls this; first POST wins, everyone else
 *      gets 410 Gone.
 *
 * Both accept ?base=<origin> or fall back to the request origin so the
 * returned contentUrl is always directly usable.
 */

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  const { token } = await params;
  try {
    const base =
      request.nextUrl.searchParams.get('base') ||
      request.headers.get('origin') ||
      new URL(request.url).origin;

    const [record, redeemed] = await Promise.all([
      peekShareLink(token, base),
      isRedeemed(token),
    ]);
    if (!record) {
      // Distinguish expired from unknown so the UI can explain properly.
      const rec = await getShareLinkRecord(token);
      if (rec?.expiresAt && rec.expiresAt <= Date.now()) {
        return NextResponse.json(
          { error: 'This link expired and can no longer be opened', expired: true },
          { status: 410 },
        );
      }
      return NextResponse.json({ error: 'This link does not exist' }, { status: 404 });
    }
    return NextResponse.json(
      { ...record, redeemable: !redeemed },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err: any) {
    console.error('[CDN-SHARE] Peek failed:', err?.message);
    return NextResponse.json({ error: 'Unable to check this link' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  const { token } = await params;
  try {
    const base =
      request.nextUrl.searchParams.get('base') ||
      request.headers.get('origin') ||
      new URL(request.url).origin;

    const result = await redeemShareLink(token, base);
    if (!result) {
      // Used vs expired — distinct messages for the recipient.
      const rec = await getShareLinkRecord(token);
      if (rec?.expiresAt && rec.expiresAt <= Date.now() && !rec.redeemed) {
        return NextResponse.json(
          { error: 'This link expired before it was opened', expired: true },
          { status: 410 },
        );
      }
      return NextResponse.json(
        { error: 'This one-time link is invalid or has already been used' },
        { status: 410 },
      );
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[CDN-SHARE] Redeem failed:', err?.message);
    return NextResponse.json({ error: 'Unable to open this link' }, { status: 500 });
  }
}

async function isRedeemed(token: string): Promise<boolean> {
  const { getShareLinkRecord } = await import('@/features/media/cdnStorage');
  const rec = await getShareLinkRecord(token);
  return !!rec?.redeemed;
}
