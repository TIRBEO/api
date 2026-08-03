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
    const { message, content } = body;
    const text = message || content;

    if (!text) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const { id } = await params;

    const ticket = await prisma.ticket.findFirst({
      where: {
        id,
        OR: [{ customerId: session.userId }, ...(session.email ? [{ customer: { email: session.email } }] : [])],
      },
    });

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const reply = await prisma.ticketMessage.create({
      data: {
        ticketId: id,
        authorId: session.userId,
        content: String(text).slice(0, 20000),
        isInternal: false,
      },
      include: {
        author: { select: { id: true, name: true, email: true, photoUrl: true } },
      },
    });

    return NextResponse.json({ ...reply, user: reply.author });
  } catch (err: any) {
    console.error('[SUPPORT] Reply error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to add reply' }, { status: 500 });
  }
}
