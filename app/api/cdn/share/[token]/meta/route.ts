import { NextRequest, NextResponse } from 'next/server';
import { getShareLinkRecord } from '@/features/media/cdnStorage';
import { isCockroachHealthy } from '@/infrastructure/db/cockroach';

export const runtime = 'nodejs';

/**
 * GET /api/cdn/share/[token]/meta — public, NON-destructive link metadata.
 * Link-preview crawlers (Slack/Discord/WhatsApp/…) hit this instead of the
 * redeeming endpoint, so previews never burn the recipient's single open.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!(await isCockroachHealthy())) {
    return NextResponse.json({ error: 'Storage temporarily unavailable' }, { status: 503 });
  }

  const { token } = await params;
  const record = await getShareLinkRecord(token).catch(() => null);
  if (!record) {
    return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  }

  return NextResponse.json({
    filename: record.filename,
    contentType: record.mimeType,
    size: record.size,
    redeemed: record.redeemed,
  });
}
