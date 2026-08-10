import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';
import { createAuditEvent } from '@/lib/audit';
import { sendTemplateEmail } from '@/lib/email';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  const ticket = await prisma.ticket.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true, email: true, photoUrl: true } },
      assigned: { select: { id: true, name: true, email: true } },
      queue: { select: { id: true, name: true } },
      messages: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, name: true, email: true, photoUrl: true } } } },
      attachments: true,
    },
  });

  if (!ticket) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } }, { status: 404 });
  return NextResponse.json(ticket);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const body: any = await request.json();
  const ticket = await prisma.ticket.findUnique({ where: { id } });
  if (!ticket) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } }, { status: 404 });

  const prevStatus = ticket.status;
  const updated = await prisma.ticket.update({
    where: { id },
    data: {
      subject: body.subject ?? body.title,
      description: body.description,
      priority: body.priority,
      status: body.status,
      queueId: body.queueId,
      assignedId: body.assignedId,
      closedAt: body.status === 'closed' || body.status === 'resolved' ? new Date() : (body.status === 'open' ? null : ticket.closedAt),
    },
  });

  await createAuditEvent({ actorId: session.userId, action: 'ADMIN_TICKET_UPDATED', targetType: 'ticket', targetId: id, metadata: { prevStatus, newStatus: body.status } });

  const customer = await prisma.user.findUnique({ where: { id: ticket.customerId }, select: { email: true } });
  if (customer?.email) {
    const statusLabel = (body.status || '').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    const isSolved = body.status === 'closed' || body.status === 'resolved';
    sendTemplateEmail(customer.email, isSolved ? 'ticket_closed' : 'ticket_updated', {
      ticketId: ticket.id,
      ticketSubject: updated.subject,
      ticketStatus: statusLabel,
      ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
      updateMessage: isSolved ? 'Your ticket has been marked as solved. If the issue persists, feel free to reopen it.' : 'Your ticket status has been updated by our support team.',
    }).catch(() => {});
  }

  if (body.assignedId && body.assignedId !== ticket.assignedId) {
    const agent = await prisma.user.findUnique({ where: { id: body.assignedId }, select: { email: true } });
    if (agent?.email) {
      sendTemplateEmail(agent.email, 'ticket_updated', {
        ticketId: ticket.id,
        ticketSubject: updated.subject,
        ticketStatus: (body.status || '').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
        updateMessage: `You have been assigned ticket #${ticket.id}. Please review and take action.`,
      }).catch(() => {});
    }
  }

  return NextResponse.json(updated);
}
