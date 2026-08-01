import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { jsonError, jsonForbidden, jsonUnauthorized, jsonSuccess } from './response';
import { createAuditEvent } from './audit';
import { sendTemplateEmail } from './email';
import { sanitizeInput } from './security';

function isAdmin(user: any): boolean {
  return user?.adminRole != null && ['super_admin', 'admin'].includes(user.adminRole);
}

export async function ticketListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');
  const status = searchParams.get('status');
  const where: any = {};
  if (status) where.status = status;
  if (!isAdmin(user)) where.customerId = user.userId;
  const [data, total] = await Promise.all([
    prisma.ticket.findMany({
      where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' },
      include: { customer: { select: { id: true, name: true, email: true } }, assigned: { select: { id: true, name: true } }, queue: true, messages: { take: 1, orderBy: { createdAt: 'desc' } } },
    }),
    prisma.ticket.count({ where }),
  ]);
  return NextResponse.json({ data, total, page, limit });
}

export async function ticketCreateHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const body = await req.json();
  const ticket = await prisma.ticket.create({
    data: {
      subject: sanitizeInput(String(body.title || ''), 300),
      description: body.description ? sanitizeInput(String(body.description), 20000) : undefined,
      priority: body.priority,
      status: body.status,
      queueId: body.queueId,
      customerId: user.userId,
    },
  });
  await createAuditEvent({ actorId: user.userId, action: 'TICKET_CREATED', targetType: 'ticket', targetId: ticket.id });

  const customer = await prisma.user.findUnique({ where: { id: user.userId }, select: { email: true } });
  if (customer?.email) {
    sendTemplateEmail(customer.email, 'ticket_created', {
      ticketId: ticket.id,
      ticketSubject: ticket.subject,
      ticketStatus: ticket.status || 'Open',
      ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
    }).catch(() => {});
  }

  return NextResponse.json(ticket, { status: 201 });
}

export async function ticketDetailHandler(req: NextRequest, ticketId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { customer: true, assigned: true, queue: true, messages: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, name: true, photoUrl: true } } } }, attachments: true },
  });
  if (!ticket) return jsonError('NOT_FOUND', 'Ticket not found', 404);
  if (ticket.customerId !== user.userId && !isAdmin(user)) return jsonForbidden();
  return NextResponse.json(ticket);
}

export async function ticketUpdateHandler(req: NextRequest, ticketId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const body = await req.json();
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return jsonError('NOT_FOUND', 'Ticket not found', 404);
  if (ticket.customerId !== user.userId && !isAdmin(user)) return jsonForbidden();

  const prevStatus = ticket.status;
  const statusLabel = (body.status || '').replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
  const updated = await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      subject: body.title,
      description: body.description,
      priority: body.priority,
      status: body.status,
      queueId: body.queueId,
      assignedId: body.assignedId,
    },
  });
  await createAuditEvent({ actorId: user.userId, action: 'TICKET_UPDATED', targetType: 'ticket', targetId: ticketId, metadata: { prevStatus, newStatus: body.status } });

  const customer = await prisma.user.findUnique({ where: { id: ticket.customerId }, select: { email: true } });
  if (customer?.email) {
    const isClosed = body.status === 'closed' || body.status === 'resolved';
    sendTemplateEmail(customer.email, isClosed ? 'ticket_closed' : 'ticket_updated', {
      ticketId: ticket.id,
      ticketSubject: updated.subject,
      ticketStatus: statusLabel,
      ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
      updateMessage: isClosed ? 'Your ticket has been marked as solved.' : 'Your ticket status has been updated.',
    }).catch(() => {});
  }

  if (isAdmin(user) && body.assignedId && body.assignedId !== ticket.assignedId) {
    const agent = await prisma.user.findUnique({ where: { id: body.assignedId }, select: { email: true } });
    if (agent?.email) {
      sendTemplateEmail(agent.email, 'ticket_updated', {
        ticketId: ticket.id,
        ticketSubject: updated.subject,
        ticketStatus: statusLabel,
        ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
        updateMessage: `You have been assigned ticket #${ticket.id}.`,
      }).catch(() => {});
    }
  }

  return NextResponse.json(updated);
}

export async function ticketMessageHandler(req: NextRequest, ticketId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return jsonError('NOT_FOUND', 'Ticket not found', 404);
  if (ticket.customerId !== user.userId && !isAdmin(user)) return jsonForbidden();
  const body = await req.json();
  const message = await prisma.ticketMessage.create({ data: { ticketId, authorId: user.userId, content: sanitizeInput(String(body.content || ''), 20000), isInternal: body.isInternal || false } });
  await createAuditEvent({ actorId: user.userId, action: 'TICKET_REPLIED', targetType: 'ticket', targetId: ticketId });
  return NextResponse.json(message, { status: 201 });
}

export async function ticketAssignHandler(req: NextRequest, ticketId: string) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const body = await req.json();
  const updated = await prisma.ticket.update({ where: { id: ticketId }, data: { assignedId: body.agentId } });
  await prisma.ticket_assignments.create({ data: { ticketId, agentId: body.agentId, assignedBy: user.userId } });
  await createAuditEvent({ actorId: user.userId, action: 'TICKET_ASSIGNED', targetType: 'ticket', targetId: ticketId, metadata: { agentId: body.agentId } });
  return NextResponse.json(updated);
}

export async function ticketCloseHandler(req: NextRequest, ticketId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return jsonError('NOT_FOUND', 'Ticket not found', 404);
  if (ticket.customerId !== user.userId && !isAdmin(user)) return jsonForbidden();
  const updated = await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'closed', closedAt: new Date() } });
  await createAuditEvent({ actorId: user.userId, action: 'TICKET_CLOSED', targetType: 'ticket', targetId: ticketId });

  const customer = await prisma.user.findUnique({ where: { id: ticket.customerId }, select: { email: true } });
  if (customer?.email) {
    sendTemplateEmail(customer.email, 'ticket_closed', {
      ticketId: ticket.id,
      ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
    }).catch(() => {});
  }

  return NextResponse.json(updated);
}

export async function ticketReopenHandler(req: NextRequest, ticketId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return jsonError('NOT_FOUND', 'Ticket not found', 404);
  if (ticket.customerId !== user.userId && !isAdmin(user)) return jsonForbidden();
  const updated = await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'open', closedAt: null } });
  return NextResponse.json(updated);
}

// Support queues
export async function queuesListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const queues = await prisma.support_queues.findMany({ include: { agents: { include: { user: { select: { id: true, name: true } } } } } });
  return NextResponse.json(queues);
}

export async function queuesCreateHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const body = await req.json();
  const queue = await prisma.support_queues.create({ data: { name: body.name, slug: body.slug, description: body.description } });
  return NextResponse.json(queue, { status: 201 });
}
