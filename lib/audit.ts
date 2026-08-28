import { prisma } from './db/prisma';
import type { Prisma } from '@prisma/client';
import { sendToUser } from './ws/server';
import { hasConsent } from './consent';

type Severity = 'info' | 'warning' | 'error' | 'critical';

interface AuditInput {
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  severity?: Severity;
}

export async function createAuditEvent(input: AuditInput) {
  // Server-side consent check: skip audit logging if user opted out of analytics
  if (input.actorId) {
    const analyticsAllowed = await hasConsent(input.actorId, 'analytics');
    if (!analyticsAllowed) {
      // Still create the audit event (it's a security record), but skip WebSocket broadcast
      // The event is stored for compliance but not surfaced in real-time
      await prisma.auditEvent.create({
        data: {
          actorId: input.actorId || null,
          action: input.action,
          targetType: input.targetType || null,
          targetId: input.targetId || null,
          metadata: (input.metadata || {}) as Prisma.InputJsonValue,
          severity: input.severity || 'info',
        },
      });
      return;
    }
  }

  const event = await prisma.auditEvent.create({
    data: {
      actorId: input.actorId || null,
      action: input.action,
      targetType: input.targetType || null,
      targetId: input.targetId || null,
      metadata: (input.metadata || {}) as Prisma.InputJsonValue,
      severity: input.severity || 'info',
    },
  });

  // Send real-time WebSocket notification to the user (only if analytics consented)
  if (input.actorId) {
    try {
      sendToUser(input.actorId, {
        type: 'activity',
        event: {
          id: event.id,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          metadata: event.metadata,
          severity: event.severity,
          createdAt: event.createdAt.toISOString(),
        },
      });
    } catch {}
  }
}

export async function listAuditEvents(options: {
  limit?: number;
  offset?: number;
  action?: string;
  actorId?: string;
  targetType?: string;
  severity?: string;
  from?: string;
  to?: string;
}) {
  const where: Record<string, unknown> = {};
  if (options.action) where.action = { contains: options.action };
  if (options.actorId) where.actorId = options.actorId;
  if (options.targetType) where.targetType = options.targetType;
  if (options.severity) where.severity = options.severity;
  if (options.from || options.to) {
    const createdAt: Record<string, Date> = {};
    if (options.from) createdAt.gte = new Date(options.from);
    if (options.to) createdAt.lte = new Date(options.to);
    where.createdAt = createdAt;
  }

  const limit = Math.min(options.limit || 50, 200);
  const offset = options.offset || 0;

  const [events, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: { actor: { select: { id: true, email: true, name: true, photoUrl: true } } },
    }),
    prisma.auditEvent.count({ where: where as any }),
  ]);

  return { events, total, limit, offset };
}
