import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const skip = (page - 1) * limit;
    const status = searchParams.get('status') || undefined;
    const category = searchParams.get('category') || undefined;
    const priority = searchParams.get('priority') || undefined;
    const search = searchParams.get('search') || undefined;

    const where: any = {};
    if (status) where.status = status;
    if (category) where.category = category;
    if (priority) where.priority = priority;
    if (search) where.OR = [{ subject: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }];

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        include: {
          customer: { select: { id: true, email: true, name: true } },
          assigned: { select: { id: true, email: true, name: true } },
          messages: {
            include: {
              author: { select: { id: true, email: true, name: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 3,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.ticket.count({ where }),
    ]);

    const mapped = tickets.map(t => ({ ...t, title: t.subject, message: t.description, user: t.customer, replies: t.messages }));
    return NextResponse.json({ tickets: mapped, total, page, limit });
  } catch (err: any) {
    console.error('[ADMIN SUPPORT] Get tickets error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch tickets' }, { status: 500 });
  }
}
