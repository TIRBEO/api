import { prisma } from './db/prisma';
import type { Prisma } from '@prisma/client';

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
      include: { actor: { select: { email: true, name: true } } },
    }),
    prisma.auditEvent.count({ where: where as any }),
  ]);

  return { events, total, limit, offset };
}
