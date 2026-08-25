import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // For non-admin users, only show emails sent to them
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true, role: true } });
    const isAdmin = user?.role === 'admin';
    const where: any = isAdmin ? {} : { toEmail: user?.email };

    const [items, total] = await Promise.all([
      prisma.email_logs.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
      prisma.email_logs.count({ where }),
    ]);

    return NextResponse.json({ items, total, limit, offset });
  } catch (err: any) {
    console.error('[EMAILS] List error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch emails' }, { status: 500 });
  }
}
