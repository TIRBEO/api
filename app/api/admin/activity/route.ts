import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { withAdmin } from '@/lib/role-guard';
import { cachedJson } from '../../../../lib/response';

export const GET = withAdmin(async (request, session) => {

  const limit = Number(request.nextUrl.searchParams.get('limit')) || 20;

  // Recent logs with actor info
  const logs = await prisma.auditEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      actor: {
        select: {
          id: true,
          email: true,
          name: true,
          photoUrl: true,
        },
      },
    },
  });

  // Online users (active in last 5 min)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const onlineUsers = await prisma.session.findMany({
    where: { lastUsedAt: { gte: fiveMinAgo }, status: 'active' },
    select: { user: { select: { id: true, email: true, name: true, photoUrl: true } } },
    orderBy: { lastUsedAt: 'desc' },
    take: limit,
  });

  return cachedJson({ logs, onlineUsers }, { ttl: 5, swr: 15 });
});
