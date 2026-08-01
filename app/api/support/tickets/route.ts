import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    const body = await request.json();
    const { subject, message, category, rayId, email } = body;

    if (!subject || !message) {
      return NextResponse.json({ error: 'Subject and message are required' }, { status: 400 });
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: session?.userId,
        email: email || session?.email || 'anonymous',
        subject,
        message,
        category: category || 'general',
        rayId,
        status: 'open',
        priority: 'medium',
      },
    });

    return NextResponse.json(ticket);
  } catch (err: any) {
    console.error('[SUPPORT] Create ticket error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to create ticket' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session?.userId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');
    const skip = (page - 1) * limit;

    const where: any = { userId: session.userId };
    const status = searchParams.get('status');
    if (status) where.status = status;

    const [tickets, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.supportTicket.count({ where }),
    ]);

    return NextResponse.json({ tickets, total, page, limit });
  } catch (err: any) {
    console.error('[SUPPORT] Get tickets error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch tickets' }, { status: 500 });
  }
}
