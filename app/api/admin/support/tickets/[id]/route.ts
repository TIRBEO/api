import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const { id } = await params;

    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, email: true, name: true } },
        assigned: { select: { id: true, email: true, name: true } },
        messages: {
          include: {
            author: { select: { id: true, email: true, name: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const mappedReplies = ticket.messages.map(m => ({ ...m, message: m.content, isAdmin: m.isInternal, user: m.author }));
    return NextResponse.json({ ...ticket, title: ticket.subject, message: ticket.description, customer: ticket.customer, user: ticket.customer, replies: mappedReplies });
  } catch (err: any) {
    console.error('[ADMIN SUPPORT] Get ticket error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch ticket' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const { id } = await params;
    const body = await request.json();
    const { status, priority, assignedId, assignedTo, category, subject, title, description } = body;

    const existing = await prisma.ticket.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const ticket = await prisma.ticket.update({
      where: { id },
      data: {
        ...(status && { status }),
        ...(priority && { priority }),
        ...((assignedId || assignedTo) && { assignedId: assignedId || assignedTo }),
        ...(category && { category }),
        ...((subject || title) && { subject: subject || title }),
        ...(description !== undefined && { description }),
        ...(status === 'resolved' || status === 'closed' ? { closedAt: new Date() } : status === 'open' ? { closedAt: null } : {}),
      },
      include: {
        customer: { select: { id: true, email: true, name: true } },
        assigned: { select: { id: true, email: true, name: true } },
      },
    });

    return NextResponse.json({ ...ticket, title: ticket.subject, user: ticket.customer });
  } catch (err: any) {
    console.error('[ADMIN SUPPORT] Update ticket error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to update ticket' }, { status: 500 });
  }
}
