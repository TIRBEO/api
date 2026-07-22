import { prisma } from './db/prisma';
import { createAuditEvent } from './audit';

export async function listReports(options: {
  limit?: number; offset?: number; status?: string; targetType?: string; reason?: string;
}) {
  const where: Record<string, unknown> = {};
  if (options.status) where.status = options.status;
  if (options.targetType) where.targetType = options.targetType;
  if (options.reason) where.reason = options.reason;

  const limit = Math.min(options.limit || 50, 200);
  const offset = options.offset || 0;

  const [items, total] = await Promise.all([
    prisma.contentReport.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      take: limit, skip: offset,
      include: {
        reporter: { select: { id: true, email: true, name: true } },
        reviewedBy: { select: { id: true, email: true, name: true } },
      },
    }),
    prisma.contentReport.count({ where: where as any }),
  ]);
  return { items, total, limit, offset };
}

export async function getReportStats() {
  const groups = await prisma.contentReport.groupBy({ by: ['status'], _count: true });
  const typeGroups = await prisma.contentReport.groupBy({ by: ['targetType'], _count: true });
  const reasonGroups = await prisma.contentReport.groupBy({ by: ['reason'], _count: true });

  const byStatus = groups.map(g => ({ status: g.status, count: g._count }));
  const byType = typeGroups.map(g => ({ targetType: g.targetType, count: g._count }));
  const byReason = reasonGroups.map(g => ({ reason: g.reason, count: g._count }));

  return { byStatus, byType, byReason };
}

export async function updateReport(id: string, data: {
  status?: string; reviewedById?: string; action?: string; notes?: string;
}) {
  const report = await prisma.contentReport.update({
    where: { id },
    data: {
      ...(data.status && { status: data.status, reviewedAt: new Date() }),
      ...(data.reviewedById && { reviewedById: data.reviewedById }),
      ...(data.action !== undefined && { action: data.action }),
      ...(data.notes !== undefined && { notes: data.notes }),
    },
  });

  // Enforce moderation actions on the target user
  if (data.action && data.status === 'actioned' && report.targetType === 'user') {
    const targetUserId = report.targetId;
    try {
      const targetUser = await prisma.user.findUnique({ where: { id: targetUserId }, select: { adminRole: true } });
      // Don't ban/suspend super admins
      if (targetUser && targetUser.adminRole !== 'super_admin') {
        if (data.action === 'banned') {
          await prisma.user.update({ where: { id: targetUserId }, data: { isBanned: true } });
          await prisma.session.deleteMany({ where: { userId: targetUserId } });
          await createAuditEvent({
            actorId: data.reviewedById || null,
            action: 'user.banned',
            targetType: 'user',
            targetId: targetUserId,
            severity: 'warning',
            metadata: { reason: 'Moderation action', reportId: id },
          });
        } else if (data.action === 'suspended') {
          await prisma.user.update({ where: { id: targetUserId }, data: { isSuspended: true } });
          await prisma.session.deleteMany({ where: { userId: targetUserId } });
          await createAuditEvent({
            actorId: data.reviewedById || null,
            action: 'user.suspended',
            targetType: 'user',
            targetId: targetUserId,
            severity: 'warning',
            metadata: { reason: 'Moderation action', reportId: id },
          });
        } else if (data.action === 'warned') {
          await createAuditEvent({
            actorId: data.reviewedById || null,
            action: 'user.warned',
            targetType: 'user',
            targetId: targetUserId,
            metadata: { reason: 'Moderation action', reportId: id },
          });
        }
      }
    } catch (err) {
      console.error('[MODERATION] Failed to enforce action:', err);
    }
  }

  return report;
}
