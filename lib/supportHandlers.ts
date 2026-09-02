import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { jsonError, jsonForbidden, jsonUnauthorized, jsonSuccess } from './response';
import { createAuditEvent } from './audit';
import { sendTemplateEmail } from './email';
import { sendToUser } from './ws/server';
import { sanitizeInput } from './security';
import { trackQuery } from './queryMonitor';
import { createNotification } from './notifications';

function isAdmin(user: any): boolean {
  return user?.adminRole != null && ['super_admin', 'admin'].includes(user.adminRole);
}

// ─── Ticket List Cache ───
// AppShell polls tickets every 15s — cache the result for 10s to avoid
// redundant DB round-trips during idle browsing.
const ticketListCache = new Map<string, { data: any; ts: number }>();
const TICKET_CACHE_TTL = 10_000;

export async function ticketListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1') || 1);
    const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') || '20') || 20), 100);
    const status = searchParams.get('status');
    const q = searchParams.get('q')?.trim();
    const scope = searchParams.get('scope');
    const cacheKey = `${user.userId}:${page}:${limit}:${status || ''}:${q || ''}:${scope || ''}`;
    const cached = ticketListCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TICKET_CACHE_TTL) {
      return NextResponse.json(cached.data);
    }

    const where: any = {};
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { subject: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (scope === 'all' && isAdmin(user)) {
    } else {
      where.customerId = user.userId;
    }
    const [data, total] = await Promise.all([
      trackQuery('tickets_by_customer_created', () => prisma.ticket.findMany({
        where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' },
        include: { customer: { select: { id: true, name: true, email: true } }, assigned: { select: { id: true, name: true } } },
      })),
      trackQuery('tickets_by_customer_count', () => prisma.ticket.count({ where })),
    ]);
    // Fetch last message for each ticket in a single query (avoids N+1 subqueries)
    if (data.length > 0) {
      const ticketIds = data.map((t: any) => t.id);
      const lastMsgs = await prisma.ticketMessage.findMany({
        where: { ticketId: { in: ticketIds } },
        orderBy: { createdAt: 'desc' },
        select: { ticketId: true, content: true, createdAt: true, authorId: true },
      });
      // Deduplicate: keep only the latest per ticket
      const seen = new Set<string>();
      for (const msg of lastMsgs) {
        if (!seen.has(msg.ticketId)) {
          seen.add(msg.ticketId);
          const ticket = data.find((t: any) => t.id === msg.ticketId);
          if (ticket) (ticket as any).messages = [msg];
        }
      }
    }
    const payload = { data, total, page, limit };
    ticketListCache.set(cacheKey, { data: payload, ts: Date.now() });
    // Evict stale cache entries (keep max 50 per user)
    if (ticketListCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of ticketListCache) {
        if (now - v.ts > TICKET_CACHE_TTL * 3) ticketListCache.delete(k);
      }
    }
    return NextResponse.json(payload);
  } catch (err: any) {
    console.error('[TICKET LIST]', err?.message || err);
    return NextResponse.json({ data: [], total: 0, page: 1, limit: 20 });
  }
}

export async function ticketCreateHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const title = sanitizeInput(String(body.title || body.subject || ''), 300).trim();
  if (!title || title.length < 3) return NextResponse.json({ error: 'Subject must be at least 3 characters' }, { status: 400 });
  let description = (body.description || body.message) ? sanitizeInput(String(body.description || body.message), 20000) : undefined;
  if (description) description = description.trim();
  if (!description || description.length < 10) return NextResponse.json({ error: 'Message must be at least 10 characters' }, { status: 400 });
  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.filter((u: unknown) => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 6) : [];
  for (const url of imageUrls) description = `${description || ''}![tirbeo-img](${url})`;
  const ticket = await prisma.ticket.create({
    data: {
      subject: sanitizeInput(String(title || ''), 300),
      description,
      category: body.category ? sanitizeInput(String(body.category), 50) : 'general',
      priority: body.priority || 'normal',
      status: body.status || 'open',
      customerId: user.userId,
      application: body.appealRayId ? `captcha-appeal:${sanitizeInput(String(body.appealRayId), 64)}` : body.application,
    },
  });
  await createAuditEvent({ actorId: user.userId, action: 'TICKET_CREATED', targetType: 'ticket', targetId: ticket.id });

  // Email to customer — respects supportEmail + global email prefs via shouldSuppressEmail inside sendTemplateEmail
  const customer = await prisma.user.findUnique({ where: { id: user.userId }, select: { email: true, name: true } });
  if (customer?.email) {
    sendTemplateEmail(customer.email, 'ticket_created', {
      ticketId: ticket.id,
      ticketSubject: ticket.subject,
      ticketStatus: ticket.status || 'Open',
      ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
    }).catch(() => {});
  }
  // In-app + push (email skipped — we already sent the dedicated ticket_created template)
  try {
    await createNotification({
      userId: user.userId,
      type: 'support',
      title: `Ticket opened: ${ticket.subject.slice(0, 80)}`,
      body: `Your ticket #${ticket.id.slice(0,8)} is open. We'll reply soon.`,
      link: `/support/tickets/${ticket.id}`,
      metadata: { ticketId: ticket.id, category: ticket.category, priority: ticket.priority },
      skipEmail: true,
    });
  } catch {}

  return NextResponse.json(ticket, { status: 201 });
}

/** GET /api/support/tickets/appeals — list open captcha-appeal tickets for admins. */
export async function ticketAppealsHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  if (!isAdmin(user)) return jsonForbidden();

  const tickets = await prisma.ticket.findMany({
    where: { application: { startsWith: 'captcha-appeal:' }, status: { not: 'closed' } },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      customer: { select: { id: true, email: true, name: true } },
    },
  });

  return NextResponse.json({ appeals: tickets });
}

/** POST /api/support/tickets/appeals/[rayId]/unblock — unblock a captcha block referenced by an appeal. */
export async function ticketAppealUnblockHandler(req: NextRequest, rayId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  if (!isAdmin(user)) return jsonForbidden();

  const decodedRayId = decodeURIComponent(rayId);
  const { unblockUser } = await import('./captcha/service');
  const ok = await unblockUser(decodedRayId, user.userId);
  if (!ok) return jsonError('NOT_FOUND', 'Block not found for Ray ID', 404);

  await createAuditEvent({
    actorId: user.userId,
    action: 'captcha.appeal_unblocked',
    targetType: 'captchaBlock',
    targetId: decodedRayId,
    metadata: { source: 'appeal' },
  });

  return NextResponse.json({ success: true, rayId: decodedRayId });
}

export async function ticketDetailHandler(req: NextRequest, ticketId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { customer: true, assigned: true, messages: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, name: true, photoUrl: true } } } }, attachments: true },
  });
  if (!ticket) return jsonError('NOT_FOUND', 'Ticket not found', 404);
  if (ticket.customerId !== user.userId && !isAdmin(user)) return jsonForbidden();
  return NextResponse.json(ticket);
}

export async function ticketUpdateHandler(req: NextRequest, ticketId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const body: any = await req.json();
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return jsonError('NOT_FOUND', 'Ticket not found', 404);
  if (ticket.customerId !== user.userId && !isAdmin(user)) return jsonForbidden();

  const prevStatus = ticket.status;
  const statusLabel = (body.status || '').replace('_', ' ').replace(/\b\w/g, (l: string) => l.toUpperCase());
  const updated = await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      subject: body.title,
      description: body.description,
      priority: body.priority,
      status: body.status,
      assignedId: body.assignedId,
      ...(body.status === 'resolved' || body.status === 'closed' ? { closedAt: new Date() } : {}),
      ...(body.status === 'open' ? { closedAt: null } : {}),
    },
  });
  await createAuditEvent({ actorId: user.userId, action: 'TICKET_UPDATED', targetType: 'ticket', targetId: ticketId, metadata: { prevStatus, newStatus: body.status } });

  // Notify customer of any status/priority change
  const customer = await prisma.user.findUnique({ where: { id: ticket.customerId }, select: { email: true, name: true } });
  const isClosed = body.status === 'closed' || body.status === 'resolved';
  const isReopened = prevStatus === 'closed' && body.status === 'open';
  const template = isClosed ? 'ticket_closed' : isReopened ? 'ticket_reopened' : 'ticket_updated';
  const notifTitle = isClosed ? `Ticket closed: ${updated.subject.slice(0,60)}` : isReopened ? `Ticket reopened: ${updated.subject.slice(0,60)}` : `Ticket updated: ${updated.subject.slice(0,60)}`;
  const notifBody = isClosed ? `Ticket #${ticket.id.slice(0,8)} was closed.` : isReopened ? `Ticket #${ticket.id.slice(0,8)} was reopened.` : `Ticket #${ticket.id.slice(0,8)} was updated.`;

  if (customer?.email) {
    const vars: Record<string, string> = {
      ticketId: ticket.id,
      ticketSubject: updated.subject,
      ticketStatus: statusLabel || updated.status,
      ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
      updateMessage: isClosed ? 'Your ticket has been marked as solved.' : isReopened ? 'Your ticket is open again and back in our queue.' : 'Your ticket status has been updated.',
    };
    sendTemplateEmail(customer.email, template, vars).catch(() => {});
  }
  // In-app notification (skipEmail since we sent dedicated template)
  try {
    await createNotification({
      userId: ticket.customerId,
      type: 'support',
      title: notifTitle,
      body: notifBody,
      link: `/support/tickets/${ticket.id}`,
      metadata: { ticketId, prevStatus, newStatus: body.status },
      skipEmail: true,
    });
  } catch {}

  if (isAdmin(user) && body.assignedId && body.assignedId !== ticket.assignedId) {
    const agent = await prisma.user.findUnique({ where: { id: body.assignedId }, select: { email: true, name: true } });
    if (agent?.email) {
      sendTemplateEmail(agent.email, 'ticket_updated', {
        ticketId: ticket.id,
        ticketSubject: updated.subject,
        ticketStatus: statusLabel,
        ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
        updateMessage: `You have been assigned ticket #${ticket.id}.`,
      }).catch(() => {});
      try {
        await createNotification({
          userId: body.assignedId,
          type: 'support',
          title: `Assigned: ${updated.subject.slice(0,50)}`,
          body: `You were assigned ticket #${ticket.id.slice(0,8)}`,
          link: `/support/tickets/${ticket.id}`,
          metadata: { ticketId },
          skipEmail: true,
        });
      } catch {}
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
  if (ticket.status === 'resolved' || ticket.status === 'closed') {
    return jsonError('TICKET_CLOSED', 'This ticket is resolved and no longer accepts messages. Open a new ticket if you need more help.', 400);
  }
  const body: any = await req.json();
  let content = sanitizeInput(String(body.content || body.message || ''), 20000).trim();
  if (!content || content.length < 1) return NextResponse.json({ error: 'Message cannot be empty' }, { status: 400 });
  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.filter((u: unknown) => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 6) : [];
  for (const url of imageUrls) content = `${content}![tirbeo-img](${url})`;
  const message = await prisma.ticketMessage.create({ data: { ticketId, authorId: user.userId, content, isInternal: isAdmin(user) ? !!body.isInternal : false } });
  await createAuditEvent({ actorId: user.userId, action: 'TICKET_REPLIED', targetType: 'ticket', targetId: ticketId });

  // Resolve recipient: if author is not customer → customer; if author is customer and ticket has assignee → assignee; otherwise no recipient (internal customer note)
  try {
    const fullTicket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { customerId: true, assignedId: true, subject: true } });
    const author = await prisma.user.findUnique({ where: { id: user.userId }, select: { name: true, email: true } });
    const replierName = author?.name || author?.email || 'Support';
    let recipientId: string | null = null;
    if (user.userId !== fullTicket?.customerId) {
      recipientId = fullTicket?.customerId || null; // Support/agent replied → notify customer
    } else if (fullTicket?.assignedId && fullTicket.assignedId !== user.userId) {
      recipientId = fullTicket.assignedId; // Customer replied → notify assigned agent
    }
    // If still no recipient and author is customer and ticket is unassigned, we don't WS-notify anyone, but still create in-app for customer as confirmation? Skipped.

    if (recipientId && !message.isInternal) {
      // WS real-time
      try {
        sendToUser(recipientId, {
          type: 'ticket_message',
          ticketId,
          message: { id: message.id, content: message.content, authorId: user.userId, isInternal: message.isInternal, createdAt: message.createdAt.toISOString() },
        });
      } catch {}

      // Email — respects supportEmail / email prefs via shouldSuppressEmail
      const recipient = await prisma.user.findUnique({ where: { id: recipientId }, select: { email: true, name: true } });
      if (recipient?.email) {
        sendTemplateEmail(recipient.email, 'ticket_replied', {
          ticketId: ticket.id,
          ticketSubject: String(fullTicket?.subject || ticket.subject).slice(0, 80),
          replierName,
          replyContent: content.slice(0, 2000),
          ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
        }).catch(() => {});
      }
      // In-app + push notification (skipEmail since explicit ticket_replied already sent)
      await createNotification({
        userId: recipientId,
        type: 'support',
        title: `New reply: ${String(fullTicket?.subject || ticket.subject).slice(0, 60)}`,
        body: content.slice(0, 140),
        link: `/support/tickets/${ticketId}`,
        metadata: { ticketId, messageId: message.id, replierName },
        skipEmail: true,
      }).catch(()=>{});
    } else if (recipientId && message.isInternal) {
      // Internal note — only notify assignee, no customer email
      try {
        sendToUser(recipientId, {
          type: 'ticket_message',
          ticketId,
          message: { id: message.id, content: message.content, authorId: user.userId, isInternal: true, createdAt: message.createdAt.toISOString() },
        });
      } catch {}
    }
  } catch {}

  return NextResponse.json(message, { status: 201 });
}

export async function ticketAssignHandler(req: NextRequest, ticketId: string) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  const body: any = await req.json();
  const updated = await prisma.ticket.update({ where: { id: ticketId }, data: { assignedId: body.agentId } });
  await createAuditEvent({ actorId: user.userId, action: 'TICKET_ASSIGNED', targetType: 'ticket', targetId: ticketId, metadata: { agentId: body.agentId, assignedBy: user.userId } });
  if (body.agentId) {
    const agent = await prisma.user.findUnique({ where: { id: body.agentId }, select: { email: true, name: true } });
    if (agent?.email) {
      sendTemplateEmail(agent.email, 'ticket_updated', {
        ticketId: updated.id,
        ticketSubject: updated.subject,
        ticketStatus: updated.status,
        ticketUrl: `https://support.tirbeo.app/tickets/${ticketId}`,
        updateMessage: `You have been assigned ticket #${updated.id.slice(0,8)}: ${updated.subject}`,
      }).catch(()=>{});
      try {
        await createNotification({
          userId: body.agentId,
          type: 'support',
          title: `Assigned: ${updated.subject.slice(0,50)}`,
          body: `You were assigned ticket #${updated.id.slice(0,8)}`,
          link: `/support/tickets/${ticketId}`,
          metadata: { ticketId },
          skipEmail: true,
        });
      } catch {}
    }
  }
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

  const customer = await prisma.user.findUnique({ where: { id: ticket.customerId }, select: { email: true, name: true } });
  if (customer?.email) {
    sendTemplateEmail(customer.email, 'ticket_closed', {
      ticketId: ticket.id,
      ticketSubject: ticket.subject,
      ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
    }).catch(() => {});
  }
  try {
    await createNotification({
      userId: ticket.customerId,
      type: 'support',
      title: `Ticket closed: ${ticket.subject.slice(0,60)}`,
      body: `Ticket #${ticket.id.slice(0,8)} was closed.`,
      link: `/support/tickets/${ticket.id}`,
      metadata:{ticketId},
      skipEmail: true,
    });
  } catch {}

  return NextResponse.json(updated);
}

export async function ticketReopenHandler(req: NextRequest, ticketId: string) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return jsonError('NOT_FOUND', 'Ticket not found', 404);
  if (ticket.customerId !== user.userId && !isAdmin(user)) return jsonForbidden();
  const updated = await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'open', closedAt: null } });
  await createAuditEvent({ actorId: user.userId, action: 'TICKET_REOPENED', targetType: 'ticket', targetId: ticketId });

  const customer = await prisma.user.findUnique({ where: { id: ticket.customerId }, select: { email: true, name: true } });
  if (customer?.email) {
    sendTemplateEmail(customer.email, 'ticket_reopened', {
      ticketId: ticket.id,
      ticketSubject: ticket.subject,
      ticketUrl: `https://support.tirbeo.app/tickets/${ticket.id}`,
    }).catch(()=>{});
  }
  try {
    await createNotification({
      userId: ticket.customerId,
      type: 'support',
      title: `Ticket reopened: ${ticket.subject.slice(0,60)}`,
      body: `Ticket #${ticket.id.slice(0,8)} was reopened and is active again.`,
      link: `/support/tickets/${ticket.id}`,
      metadata:{ticketId},
      skipEmail: true,
    });
  } catch {}
  // Also notify assignee if reopened by customer
  if (ticket.assignedId && ticket.assignedId !== user.userId) {
    try {
      await createNotification({
        userId: ticket.assignedId,
        type: 'support',
        title: `Ticket reopened: ${ticket.subject.slice(0,60)}`,
        body: `Ticket #${ticket.id.slice(0,8)} was reopened by ${customer?.name || customer?.email || 'customer'}.`,
        link: `/support/tickets/${ticket.id}`,
        metadata:{ticketId},
        skipEmail: true,
      });
    } catch {}
  }
  return NextResponse.json(updated);
}

// Support queues
export async function queuesListHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  return NextResponse.json([]);
}

export async function queuesCreateHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user || !isAdmin(user)) return jsonForbidden();
  return NextResponse.json({ error: 'Support queues removed' }, { status: 410 });
}

// ─── POST /api/support/tickets/[id]/read — mark messages read ────────
export async function ticketMarkReadHandler(req: NextRequest, ticketId: string) {
  const session = await getSession(req);
  if (!session) return jsonUnauthorized();

  const body: any = await req.json().catch(() => ({}));
  const messageIds: string[] = Array.isArray(body.messageIds) ? body.messageIds : [];

  if (messageIds.length > 0) {
    await prisma.ticketMessage.updateMany({
      where: {
        id: { in: messageIds },
        ticketId,
        authorId: { not: session.userId },
      },
      data: { readAt: new Date(), readBy: session.userId },
    });
  } else {
    await prisma.ticketMessage.updateMany({
      where: { ticketId, authorId: { not: session.userId }, readAt: null },
      data: { readAt: new Date(), readBy: session.userId },
    });
  }

  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { customerId: true, assignedId: true },
  });
  if (ticket) {
    const recipientId = ticket.customerId === session.userId ? ticket.assignedId : ticket.customerId;
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
}

// ─── GET /api/support/tickets/[id]/attachments ──────────────────────
export async function ticketAttachmentsListHandler(req: NextRequest, ticketId: string) {
  try {
    const session = await getSession(req);
    if (!session) return jsonUnauthorized();
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { customerId: true } });
    if (!ticket) return jsonError('NOT_FOUND', 'Ticket not found', 404);
    if (ticket.customerId !== session.userId && !isAdmin(session)) return jsonForbidden();
    const attachments = await prisma.ticket_attachments.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        fileName: true,
        fileUrl: true,
        fileSize: true,
        mimeType: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ attachments });
  } catch (err: any) {
    console.error('[TICKET ATTACHMENTS LIST]', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch attachments' }, { status: 500 });
  }
}

// ─── POST /api/support/tickets/[id]/attachments ──────────────────────
export async function ticketAttachmentsUploadHandler(req: NextRequest, ticketId: string) {
  try {
    const session = await getSession(req);
    if (!session) return jsonUnauthorized();
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { customerId: true, status: true } });
    if (!ticket) return jsonError('NOT_FOUND', 'Ticket not found', 404);
    if (ticket.customerId !== session.userId && !isAdmin(session)) return jsonForbidden();
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
      return jsonError('TICKET_CLOSED', 'This ticket is closed and no longer accepts attachments.', 400);
    }
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400 });
    const allowedMime = /^(image\/(jpeg|png|gif|webp|svg\+xml)|application\/pdf|text\/(plain|csv)|application\/(msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|json|octet-stream)|)$/i;
    if (file.type && !allowedMime.test(file.type) && !file.type.startsWith('image/')) {
    }
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const key = `tickets/${ticketId}/${Date.now()}-${Math.random().toString(36).slice(2,6)}-${safeName}`;
    let fileUrl: string;
    try {
      const { storeMediaFile } = await import('./mediaStorage');
      const stored = await storeMediaFile({ key, body: buffer, contentType: file.type || 'application/octet-stream' });
      fileUrl = stored.url;
    } catch (e: any) {
      console.error('[TICKET ATTACHMENTS] R2 failed, falling back to data URL:', e.message);
      fileUrl = `data:${file.type || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
    }
    const attachment = await prisma.ticket_attachments.create({
      data: {
        ticketId,
        fileName: file.name,
        fileUrl,
        fileSize: file.size,
        mimeType: file.type,
      },
      select: {
        id: true,
        fileName: true,
        fileUrl: true,
        fileSize: true,
        mimeType: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ attachment }, { status: 201 });
  } catch (err: any) {
    console.error('[TICKET ATTACHMENTS UPLOAD]', err?.message || err);
    return NextResponse.json({ error: 'Failed to upload attachment' }, { status: 500 });
  }
}

// ─── GET /api/support/tickets/[id]/attachments/[attachmentId] — signed download ───
export async function ticketAttachmentDownloadHandler(req: NextRequest, ticketId: string, attachmentId: string) {
  try {
    const session = await getSession(req);
    if (!session) return jsonUnauthorized();
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { customerId: true } });
    if (!ticket) return jsonError('NOT_FOUND', 'Ticket not found', 404);
    if (ticket.customerId !== session.userId && !isAdmin(session)) return jsonForbidden();
    const att = await prisma.ticket_attachments.findFirst({ where: { id: attachmentId, ticketId } });
    if (!att) return jsonError('NOT_FOUND', 'Attachment not found', 404);

    if (att.fileUrl.startsWith('data:')) {
      const m = att.fileUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return NextResponse.json({ error: 'Invalid data URL' }, { status: 500 });
      const [, mime, b64] = m;
      const buf = Buffer.from(b64, 'base64');
      return new NextResponse(buf, {
        headers: {
          'Content-Type': mime || att.mimeType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(att.fileName).replace(/%20/g, ' ')}"`,
          'Content-Length': String(buf.length),
          'Cache-Control': 'private, max-age=300',
        },
      });
    }

    try {
      const url = new URL(att.fileUrl);
      const bucket = process.env.R2_BUCKET || process.env.S3_BUCKET || '';
      let key = url.pathname.replace(/^\//, '');
      if (bucket && key.startsWith(bucket + '/')) key = key.slice(bucket.length + 1);
      const { getObject } = await import('./storage');
      const envEndpoint = process.env.R2_ENDPOINT || process.env.S3_API_ENDPOINT || '';
      const envAccess = process.env.R2_ACCESS_KEY || process.env.ACCESS_KEY_ID || '';
      const envSecret = process.env.R2_SECRET_KEY || process.env.SECRET_ACCESS_KEY || '';
      const envBucket = bucket;
      if (!envEndpoint || !envAccess || !envSecret || !envBucket) {
        return NextResponse.redirect(att.fileUrl, 302);
      }
      const obj = await getObject({ endpoint: envEndpoint, accessKey: envAccess, secretKey: envSecret, bucket: envBucket, key });
      if (!obj) return NextResponse.json({ error: 'File not found on storage' }, { status: 404 });
      return new NextResponse(new Uint8Array(obj.data), {
        headers: {
          'Content-Type': obj.contentType || att.mimeType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(att.fileName).replace(/%20/g, ' ')}"`,
          'Content-Length': String(obj.data.length),
          'Cache-Control': 'private, max-age=300',
        },
      });
    } catch (e: any) {
      console.error('[TICKET ATTACHMENT DOWNLOAD] R2 get failed:', e.message);
      return NextResponse.redirect(att.fileUrl, 302);
    }
  } catch (err: any) {
    console.error('[TICKET ATTACHMENT DOWNLOAD]', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch attachment' }, { status: 500 });
  }
}
