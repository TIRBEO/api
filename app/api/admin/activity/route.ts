import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { requireAdmin } from '../../../../lib/session';
import { cachedJson } from '../../../../lib/response';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const limit = Number(request.nextUrl.searchParams.get('limit')) || 20;

  // Recent logs
  const logs = await prisma.log.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  // Online users (active in last 5 min)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const onlineUsers = await prisma.user.findMany({
    where: { lastActiveAt: { gte: fiveMinAgo } },
    select: { id: true, email: true, name: true, photoUrl: true, adminRole: true, lastActiveAt: true },
    orderBy: { lastActiveAt: 'desc' },
  });

  return cachedJson({ logs, onlineUsers }, { ttl: 5, swr: 15 });
}
