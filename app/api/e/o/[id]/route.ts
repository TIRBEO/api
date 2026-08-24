import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export const runtime = 'nodejs';

const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/** GET /api/e/o/[id] — open-tracking pixel; stamps opened_at once. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (id && id.length <= 64) {
      await prisma.$executeRaw`
        UPDATE "email_logs" SET "opened_at" = NOW()
        WHERE "id" = ${id} AND "opened_at" IS NULL`;
    }
  } catch { /* tracking is best-effort */ }

  return new NextResponse(new Uint8Array(PIXEL), {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    },
  });
}
