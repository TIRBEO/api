import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { isHostAllowed } from '@/config/app-urls';

export const runtime = 'nodejs';

/** GET /api/e/c/[id]?u=<base64url> — click tracking; stamps clicked_at then redirects.
 *
 *  The `u` parameter is attacker-controllable input on a route that requires no
 *  session, so it is only ever followed to a host this platform already trusts
 *  as a redirect target. Without that check the endpoint is an open redirect:
 *  a phisher can put `api.tirbeo.com` in front of their own address and have it
 *  be the trusted part of the link. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const raw = new URL(request.url).searchParams.get('u') || '';
  let target: string | null = null;
  try {
    const url = new URL(Buffer.from(raw, 'base64url').toString('utf8'));
    if ((url.protocol === 'https:' || url.protocol === 'http:') && isHostAllowed(url.hostname)) {
      target = url.href;
    }
  } catch { /* not a URL we can stand behind */ }

  try {
    if (id && id.length <= 64) {
      await prisma.$executeRaw`
        UPDATE "public"."email_deliveries" SET "clicked_at" = NOW()
        WHERE "id" = ${id} AND "clicked_at" IS NULL`;
    }
  } catch { /* tracking is best-effort */ }

  if (!target) return NextResponse.json({ error: 'Invalid link' }, { status: 400 });
  return NextResponse.redirect(target, 302);
}
