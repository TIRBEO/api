import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';
import { createAuditEvent } from '@/features/security/audit';
import { sendTemplateEmail } from '@/features/email/email';
import { createNotification } from '@/features/notifications/notifications';
import { sendToUserWs } from '@/infrastructure/realtime/ws-deliver';
import { getSupportBaseUrl } from '@/config/app-urls';

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
    // 1. Email to customer
    const customer = await prisma.user.findUnique({ where: { id: ticket.customerId }, select: { email: true, name: true } });
    if (customer?.email) {
      sendTemplateEmail(customer.email, 'ticket_updated', {
        ticketId: ticket.id,
        ticketSubject: ticket.subject,
        ticketStatus: ticket.status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        ticketUrl: `${getSupportBaseUrl()}/tickets/${ticket.id}`,
        updateMessage: 'Support team has replied to your ticket.',
      }).catch(() => {});
    }

    // 2. In-app notification to customer (skipEmail — dedicated template already sent above)
    createNotification({
      userId: ticket.customerId,
      type: 'support',
      title: `New reply: ${ticket.subject}`,
      body: content.trim().slice(0, 200),
      link: `/support/tickets/${ticket.id}`,
      skipEmail: true,
    }).catch(() => {});

    // 3. WS domain event — live chat feed
    sendToUserWs(ticket.customerId, {
      type: 'ticket_message',
      ticketId: ticket.id,
      message: { id: message.id, content: message.content, authorId: session.userId, isInternal: false, createdAt: message.createdAt.toISOString() },
    }).catch(() => {});
  }

  return NextResponse.json(message, { status: 201 });
}
