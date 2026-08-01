import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const { id } = await params;

    const ticket = await prisma.supportTicket.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, name: true } },
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
    const { status, priority, assignedTo, category } = body;

    const ticket = await prisma.supportTicket.update({
      where: { id },
      data: {
        ...(status && { status }),
        ...(priority && { priority }),
        ...(assignedTo !== undefined && { assignedTo }),
        ...(category && { category }),
        ...(status === 'resolved' || status === 'closed' ? { resolvedAt: new Date() } : {}),
      },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    });

    return NextResponse.json(ticket);
  } catch (err: any) {
    console.error('[ADMIN SUPPORT] Update ticket error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to update ticket' }, { status: 500 });
  }
}
