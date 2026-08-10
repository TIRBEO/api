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

    const ticket = await prisma.ticket.findFirst({
      where: {
        id: params.id,
        OR: [
          { customerId: session.userId },
          ...(session.email ? [{ customer: { email: session.email } }] : []),
        ],
      },
      include: {
        customer: { select: { id: true, name: true, email: true } },
        messages: {
          include: {
            author: { select: { id: true, name: true, email: true, photoUrl: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    return NextResponse.json({ ...ticket, title: ticket.subject });
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

    const body: any = await request.json();
    const { status, priority } = body;

    const existing = await prisma.ticket.findFirst({
      where: {
        id: params.id,
        OR: [{ customerId: session.userId }, ...(session.email ? [{ customer: { email: session.email } }] : [])],
      },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const ticket = await prisma.ticket.update({
      where: { id: params.id },
      data: {
        ...(status && { status }),
        ...(priority && { priority }),
        ...(status === 'resolved' || status === 'closed' ? { closedAt: new Date() } : {}),
      },
    });

    return NextResponse.json({ ...ticket, title: ticket.subject });
  } catch (err: any) {
    console.error('[SUPPORT] Update ticket error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to update ticket' }, { status: 500 });
  }
}
