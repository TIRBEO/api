import { NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { withAdmin } from '@/features/auth/role-guard';
import { eventRowRef } from '@/features/users/refcode';

export const GET = withAdmin(async (request, _session) => {

  const limit = Math.min(200, Math.max(10, Number(request.nextUrl.searchParams.get('limit')) || 20));
  // Severity is a filter the console offers, so the ledger answers it here
  // rather than making the panel pull everything and sort it in the browser.
  const severity = request.nextUrl.searchParams.get('severity');
  const where = severity && ['info', 'warning', 'error', 'critical'].includes(severity)
    ? { severity: severity as 'info' | 'warning' | 'error' | 'critical' }
    : {};

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
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: userSelect } } }),
    // Online users (active in last 5 min) — deduplicate by userId
    prisma.userSession.findMany({
      where: { lastUsedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) }, status: 'active' },
      select: { lastUsedAt: true, user: { select: userSelect } },
      orderBy: { lastUsedAt: 'desc' },
      take: limit * 2, // fetch more to account for duplicates
    }),
  ]);

  // Deduplicate: a user with multiple active sessions should appear once
  const seenUserIds = new Set<string>();
  const onlineUsers = rawSessions
    .filter(s => { if (seenUserIds.has(s.user.id)) return false; seenUserIds.add(s.user.id); return true; })
    .slice(0, limit)
    .map(s => ({ user: flatUser(s.user), lastUsedAt: s.lastUsedAt ? s.lastUsedAt.toISOString() : null }));

  return NextResponse.json({ logs: logs.map((l: any) => ({ ...l, ref: eventRowRef(l), user: flatUser(l.user), actor: flatUser(l.user) })), onlineUsers }, { headers: { 'Cache-Control': 'private, no-store' } });
});
