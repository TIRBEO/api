import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // For non-admin users, only show emails sent to them.
    // `role` is gone — the rebuild replaced it with an `isAdmin` flag plus an
    // optional `adminRole` label, so selecting the old column made this whole
    // route fail Prisma validation and answer 500 to everyone.
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true, isAdmin: true } });
    const isAdmin = user?.isAdmin === true;
    const where: any = isAdmin ? {} : { toEmail: user?.email };

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
