import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export const runtime = 'nodejs';

/** GET /api/e/c/[id]?u=<base64url> — click tracking; stamps clicked_at then redirects. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const raw = new URL(request.url).searchParams.get('u') || '';
  let target: string | null = null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    if (/^https?:\/\//i.test(decoded)) target = decoded;
  } catch { /* fall through */ }

  try {
    if (id && id.length <= 64) {
      await prisma.$executeRaw`
        UPDATE "email_logs" SET "clicked_at" = NOW()
        WHERE "id" = ${id} AND "clicked_at" IS NULL`;
    }
  } catch { /* tracking is best-effort */ }

  if (!target) return new NextResponse('Invalid link', { status: 400 });
  return NextResponse.redirect(target, 302);
}
