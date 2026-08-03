import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const body = await request.json();
    const { message } = body;

    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const { id } = await params;

    const ticket = await prisma.ticket.findUnique({ where: { id } });

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const reply = await prisma.ticketMessage.create({
      data: {
        ticketId: id,
        authorId: (session as any).userId,
        content: String(message).slice(0, 20000),
        isInternal: true,
      },
      include: {
        author: { select: { id: true, email: true, name: true } },
      },
    });

    await prisma.ticket.update({
      where: { id },
      data: { updatedAt: new Date() },
    });

    return NextResponse.json({ ...reply, message: reply.content, isAdmin: reply.isInternal, user: reply.author });
  } catch (err: any) {
    console.error('[ADMIN SUPPORT] Reply error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to add reply' }, { status: 500 });
  }
}
