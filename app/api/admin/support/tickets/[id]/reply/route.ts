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

    const ticket = await prisma.supportTicket.findUnique({
      where: { id },
    });

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const reply = await prisma.supportTicketReply.create({
      data: {
        ticketId: id,
        userId: (session as any).userId,
        message,
        isAdmin: true,
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
    console.error('[ADMIN SUPPORT] Reply error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to add reply' }, { status: 500 });
  }
}
