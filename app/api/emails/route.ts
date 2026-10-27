import { NextRequest, NextResponse } from 'next/server';
import { holdsPermission, requireSession } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';
import { clampLimit, clampOffset } from '@/shared/limit';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;

    const url = new URL(request.url);
    const limit = clampLimit(url.searchParams.get('limit'), { fallback: 50, max: 200 });
    const offset = clampOffset(url.searchParams.get('offset'));

    /* Staff see the whole ledger only when their role carries `email.read`;
       `is_admin` answers "some kind of staff", which is not the same question.
       Anyone else — including a staff account whose mail access was revoked —
       gets the deliveries addressed to them, which is their own record of what
       the platform sent them. */
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } });
    const seesAll = await holdsPermission(request, 'email.read');
    const where: any = seesAll ? {} : { toEmail: user?.email };

    const [items, total] = await Promise.all([
      prisma.email_deliveries.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      prisma.email_deliveries.count({ where }),
    ]);

    return NextResponse.json({ items, total, limit, offset });
  } catch (err: any) {
    console.error('[EMAILS] List error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch emails' }, { status: 500 });
  }
}
