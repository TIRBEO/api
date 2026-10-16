import { NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { withAdmin } from '@/features/auth/role-guard';

export const GET = withAdmin(async (request, session) => {

  const limit = Number(request.nextUrl.searchParams.get('limit')) || 20;

  // Name and photo live on user_profile, not on the users row — asking Prisma
  // for user { name, photoUrl } fails the whole query. Read them through the
  // relation and flatten them back into the shape this screen already expects.
  const userSelect = {
    id: true,
    email: true,
    profile: { select: { name: true, photoUrl: true } } } as const;
  const flatUser = (u: any) => u && ({
    id: u.id,
    email: u.email,
    name: u.profile?.name ?? null,
    photoUrl: u.profile?.photoUrl ?? null });

  // Parallelize: logs + online users in a single round-trip batch
  const [logs, rawSessions] = await Promise.all([
    prisma.activityEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: userSelect } } }),
    // Online users (active in last 5 min) — deduplicate by userId
    prisma.userSession.findMany({
      where: { lastUsedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) }, status: 'active' },
      select: { user: { select: userSelect } },
      orderBy: { lastUsedAt: 'desc' },
      take: limit * 2, // fetch more to account for duplicates
    }),
  ]);

  // Deduplicate: a user with multiple active sessions should appear once
  const seenUserIds = new Set<string>();
  const onlineUsers = rawSessions
    .filter(s => { if (seenUserIds.has(s.user.id)) return false; seenUserIds.add(s.user.id); return true; })
    .slice(0, limit)
    .map(s => ({ user: flatUser(s.user) }));

  return NextResponse.json({ logs: logs.map((l: any) => ({ ...l, user: flatUser(l.user), actor: flatUser(l.user) })), onlineUsers }, { headers: { 'Cache-Control': 'private, no-store' } });
});
