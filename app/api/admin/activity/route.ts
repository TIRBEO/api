import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { withAdmin } from '@/lib/role-guard';
import { cachedJson } from '../../../../lib/response';

export const GET = withAdmin(async (request, session) => {

  const limit = Number(request.nextUrl.searchParams.get('limit')) || 20;

  // Parallelize: logs + online users in a single round-trip batch
  const [logs, rawSessions] = await Promise.all([
    prisma.auditEvent.findMany({
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
    }),
    // Online users (active in last 5 min) — deduplicate by userId
    prisma.session.findMany({
      where: { lastUsedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) }, status: 'active' },
      select: { user: { select: { id: true, email: true, name: true, photoUrl: true } } },
      orderBy: { lastUsedAt: 'desc' },
      take: limit * 2, // fetch more to account for duplicates
    }),
  ]);

  // Deduplicate: a user with multiple active sessions should appear once
  const seenUserIds = new Set<string>();
  const onlineUsers = rawSessions
    .filter(s => { if (seenUserIds.has(s.user.id)) return false; seenUserIds.add(s.user.id); return true; })
    .slice(0, limit);

  return cachedJson({ logs, onlineUsers }, { ttl: 5, swr: 15 });
});
