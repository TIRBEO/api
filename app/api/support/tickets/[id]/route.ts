import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  try {
    const session = await getSession(request);
    if (!session?.userId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const ticket = await prisma.supportTicket.findFirst({
      where: {
        id: params.id,
        OR: [
          { userId: session.userId },
          { email: session.email },
        ],
      },
      include: {
        replies: {
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    return NextResponse.json(ticket);
  } catch (err: any) {
    console.error('[SUPPORT] Get ticket error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch ticket' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  try {
    const session = await getSession(request);
    if (!session?.userId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const body = await request.json();
    const { status, priority } = body;

    const ticket = await prisma.supportTicket.update({
      where: { id: params.id },
      data: {
        ...(status && { status }),
        ...(priority && { priority }),
        ...(status === 'resolved' || status === 'closed' ? { resolvedAt: new Date() } : {}),
      },
    });

    return NextResponse.json(ticket);
  } catch (err: any) {
    console.error('[SUPPORT] Update ticket error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to update ticket' }, { status: 500 });
  }
}
