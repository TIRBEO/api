import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';
import { createAuditEvent } from '@/lib/audit';
import { sendTemplateEmail } from '@/lib/email';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const body: any = await request.json();
  const { content, isInternal = false } = body;

  if (!content || !content.trim()) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Message content is required' } }, { status: 400 });
  }

  const { id } = await params;

  const ticket = await prisma.ticket.findUnique({ where: { id } });
  if (!ticket) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } }, { status: 404 });

  const message = await prisma.ticketMessage.create({
    data: { ticketId: id, authorId: session.userId, content: content.trim(), isInternal },
    include: { author: { select: { id: true, name: true, email: true, photoUrl: true } } },
  });

  await createAuditEvent({ actorId: session.userId, action: isInternal ? 'ADMIN_TICKET_NOTE' : 'ADMIN_TICKET_REPLY', targetType: 'ticket', targetId: id });

  if (!isInternal) {
    const customer = await prisma.user.findUnique({ where: { id: ticket.customerId }, select: { email: true } });
    if (customer?.email) {
      sendTemplateEmail(customer.email, 'ticket_updated', {
        ticketId: ticket.id,
        ticketSubject: ticket.subject,
        ticketStatus: ticket.status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
        updateMessage: 'Support team has replied to your ticket.',
      }).catch(() => {});
    }
  }

  return NextResponse.json(message, { status: 201 });
}
