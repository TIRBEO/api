import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../../../lib/db/prisma';
import { getSessionFromRequest } from '../../../../../../lib/auth/session';
import { sendToUser } from '../../../../../../lib/ws/server';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(request);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: ticketId } = await params;
    const body: any = await request.json().catch(() => ({}));
    const messageIds: string[] = body.messageIds || [];

    // Mark messages as read
    if (messageIds.length > 0) {
      await prisma.ticketMessage.updateMany({
        where: {
          id: { in: messageIds },
          ticketId,
          authorId: { not: session.userId }, // Don't mark own messages
        },
        data: {
          readAt: new Date(),
          readBy: session.userId,
        },
      });
    } else {
      // Mark all unread messages in the ticket as read
      await prisma.ticketMessage.updateMany({
        where: {
          ticketId,
          authorId: { not: session.userId },
          readAt: null,
        },
        data: {
          readAt: new Date(),
          readBy: session.userId,
        },
      });
    }

    // Get ticket to notify the other party
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { customerId: true, assignedId: true },
    });

    // Send WebSocket notification to the other party
    if (ticket) {
      const recipientId = ticket.customerId === session.userId
        ? ticket.assignedId
        : ticket.customerId;

      if (recipientId) {
        try {
          sendToUser(recipientId, {
            type: 'message_read',
            ticketId,
            readBy: session.userId,
            messageIds,
            readAt: new Date().toISOString(),
          });
        } catch {}
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[READ_RECEIPTS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to mark as read' }, { status: 500 });
  }
}
