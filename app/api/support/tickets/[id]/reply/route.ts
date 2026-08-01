import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession(request);
    if (!session?.userId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const body = await request.json();
    const { message } = body;

    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const { id } = await params;

    const ticket = await prisma.supportTicket.findUnique({
      where: { id },
    });

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const reply = await prisma.supportTicketReply.create({
      data: {
        ticketId: id,
        userId: session.userId,
        message,
        isAdmin: false,
      },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    });

    await prisma.supportTicket.update({
      where: { id },
      data: { updatedAt: new Date() },
    });

    return NextResponse.json(reply);
  } catch (err: any) {
    console.error('[SUPPORT] Reply error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to add reply' }, { status: 500 });
  }
}
