import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { jsonUnauthorized } from './response';

// ─── Follow / Unfollow ──────────────────────────────────

export async function followHandler(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  if (request.method === 'POST') {
    const body = await request.json();
    const { userId } = body;
    if (!userId || userId === session.userId) {
      return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
    }
    const targetUser = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!targetUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const existing = await prisma.follows.findUnique({
      where: { followerId_followingId: { followerId: session.userId, followingId: userId } },
    });
    if (existing) return NextResponse.json({ alreadyFollowing: true });

    await prisma.follows.create({
      data: { followerId: session.userId, followingId: userId },
    });
    return NextResponse.json({ followed: true }, { status: 201 });
  }

  if (request.method === 'DELETE') {
    const body = await request.json();
    const { userId } = body;
    if (!userId) return NextResponse.json({ error: 'User ID required' }, { status: 400 });
    await prisma.follows.deleteMany({
      where: { followerId: session.userId, followingId: userId },
    });
    return NextResponse.json({ unfollowed: true });
  }

  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}

// ─── List Following ─────────────────────────────────────

export async function followingHandler(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 50, 100);
  const offset = Number(request.nextUrl.searchParams.get('offset')) || 0;
  const search = request.nextUrl.searchParams.get('search') || '';

  const where: any = { followerId: session.userId };
  const userWhere: any = {};
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    userWhere.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.follows.findMany({
      where,
      include: {
        following: {
          select: {
            id: true, name: true, email: true, photoUrl: true,
            bio: true, occupation: true, country: true, isVerified: true,
            karmaPoints: true, createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.follows.count({ where }),
  ]);

  const filtered = search.trim()
    ? items.filter((f) => {
        const u = f.following;
        const q = search.toLowerCase();
        return (u.name?.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
      })
    : items;

  return NextResponse.json({
    items: filtered.map((f) => ({
      ...f.following,
      followedAt: f.createdAt,
      isFollowing: true,
    })),
    total,
    hasMore: offset + limit < total,
  });
}

// ─── List Followers ─────────────────────────────────────

export async function followersHandler(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 50, 100);
  const offset = Number(request.nextUrl.searchParams.get('offset')) || 0;
  const search = request.nextUrl.searchParams.get('search') || '';

  const where: any = { followingId: session.userId };

  const [items, total] = await Promise.all([
    prisma.follows.findMany({
      where,
      include: {
        follower: {
          select: {
            id: true, name: true, email: true, photoUrl: true,
            bio: true, occupation: true, country: true, isVerified: true,
            karmaPoints: true, createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.follows.count({ where }),
  ]);

  const filtered = search.trim()
    ? items.filter((f) => {
        const u = f.follower;
        const q = search.toLowerCase();
        return (u.name?.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
      })
    : items;

  const followerIds = filtered.map((f) => f.follower.id);
  const myFollowing = await prisma.follows.findMany({
    where: { followerId: session.userId, followingId: { in: followerIds } },
    select: { followingId: true },
  });
  const followingSet = new Set(myFollowing.map((f) => f.followingId));

  return NextResponse.json({
    items: filtered.map((f) => ({
      ...f.follower,
      followedAt: f.createdAt,
      isFollowing: followingSet.has(f.follower.id),
    })),
    total,
    hasMore: offset + limit < total,
  });
}

// ─── List Connections (mutual follows) ──────────────────

export async function connectionsHandler(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 50, 100);
  const offset = Number(request.nextUrl.searchParams.get('offset')) || 0;
  const search = request.nextUrl.searchParams.get('search') || '';

  const myFollowing = await prisma.follows.findMany({
    where: { followerId: session.userId },
    select: { followingId: true },
  });
  const followingIds = myFollowing.map((f) => f.followingId);

  if (followingIds.length === 0) {
    return NextResponse.json({ items: [], total: 0, hasMore: false });
  }

  const mutualFollows = await prisma.follows.findMany({
    where: {
      followerId: { in: followingIds },
      followingId: session.userId,
    },
    include: {
      follower: {
        select: {
          id: true, name: true, email: true, photoUrl: true,
          bio: true, occupation: true, country: true, isVerified: true,
          karmaPoints: true, createdAt: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });

  const filtered = search.trim()
    ? mutualFollows.filter((f) => {
        const u = f.follower;
        const q = search.toLowerCase();
        return (u.name?.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
      })
    : mutualFollows;

  return NextResponse.json({
    items: filtered.map((f) => ({
      ...f.follower,
      connectedAt: f.createdAt,
    })),
    total: mutualFollows.length,
    hasMore: offset + limit < mutualFollows.length,
  });
}

// ─── Profile View Tracking ──────────────────────────────

export async function profileViewTrackHandler(request: NextRequest) {
  if (request.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const session = await getSession(request);
  const body = await request.json();
  const { profileId } = body;
  if (!profileId) return NextResponse.json({ error: 'profileId required' }, { status: 400 });

  if (session?.userId === profileId) return NextResponse.json({ tracked: true, self: true });

  try {
    await prisma.profile_views.create({
      data: {
        viewerId: session?.userId || null,
        profileId,
        userAgent: request.headers.get('user-agent') || null,
        ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
      },
    });
  } catch {}
  return NextResponse.json({ tracked: true });
}

// ─── Profile Views List ─────────────────────────────────

export async function profileViewsHandler(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 50, 200);

  const views = await prisma.profile_views.findMany({
    where: { profileId: session.userId },
    include: {
      viewer: {
        select: { id: true, name: true, email: true, photoUrl: true, isVerified: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const uniqueViewers = new Map<string, { count: number; lastViewed: Date; viewer: any }>();
  for (const view of views) {
    const key = view.viewerId || 'anonymous';
    const existing = uniqueViewers.get(key);
    if (existing) {
      existing.count++;
      if (view.createdAt > existing.lastViewed) existing.lastViewed = view.createdAt;
    } else {
      uniqueViewers.set(key, {
        count: 1,
        lastViewed: view.createdAt,
        viewer: view.viewer || { name: 'Anonymous', email: '', photoUrl: null },
      });
    }
  }

  const totalViews = await prisma.profile_views.count({ where: { profileId: session.userId } });
  const todayViews = await prisma.profile_views.count({
    where: { profileId: session.userId, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
  });
  const weekViews = await prisma.profile_views.count({
    where: { profileId: session.userId, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
  });

  return NextResponse.json({
    views: Array.from(uniqueViewers.values())
      .sort((a, b) => b.lastViewed.getTime() - a.lastViewed.getTime())
      .slice(0, 50)
      .map((v) => ({
        ...v.viewer,
        viewCount: v.count,
        lastViewed: v.lastViewed,
      })),
    stats: { totalViews, todayViews, weekViews },
  });
}

// ─── Analytics ──────────────────────────────────────────

export async function analyticsHandler(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  const userId = session.userId;
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86400000);
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const monthAgo = new Date(now.getTime() - 30 * 86400000);

  const [
    totalAuditEvents,
    eventsThisWeek,
    eventsThisMonth,
    loginCount,
    loginThisWeek,
    profileViewsToday,
    profileViewsWeek,
    profileViewsTotal,
    followerCount,
    followingCount,
    connectionCount,
    securityEventsCount,
  ] = await Promise.all([
    prisma.auditEvent.count({ where: { actorId: userId } }),
    prisma.auditEvent.count({ where: { actorId: userId, createdAt: { gte: weekAgo } } }),
    prisma.auditEvent.count({ where: { actorId: userId, createdAt: { gte: monthAgo } } }),
    prisma.auditEvent.count({ where: { actorId: userId, action: { contains: 'LOGIN' } } }),
    prisma.auditEvent.count({ where: { actorId: userId, action: { contains: 'LOGIN' }, createdAt: { gte: weekAgo } } }),
    prisma.profile_views.count({ where: { profileId: userId, createdAt: { gte: dayAgo } } }),
    prisma.profile_views.count({ where: { profileId: userId, createdAt: { gte: weekAgo } } }),
    prisma.profile_views.count({ where: { profileId: userId } }),
    prisma.follows.count({ where: { followingId: userId } }),
    prisma.follows.count({ where: { followerId: userId } }),
    prisma.follows.count({ where: { followerId: userId, followingId: { in: (await prisma.follows.findMany({ where: { followingId: userId }, select: { followerId: true } })).map((f) => f.followerId) } } }),
    prisma.securityEvent.count({ where: { userId } }),
  ]);

  // Daily activity for the last 7 days
  const dailyActivity: { date: string; events: number; logins: number; views: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(now.getTime() - i * 86400000);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400000);

    const [events, logins, views] = await Promise.all([
      prisma.auditEvent.count({ where: { actorId: userId, createdAt: { gte: dayStart, lt: dayEnd } } }),
      prisma.auditEvent.count({ where: { actorId: userId, action: { contains: 'LOGIN' }, createdAt: { gte: dayStart, lt: dayEnd } } }),
      prisma.profile_views.count({ where: { profileId: userId, createdAt: { gte: dayStart, lt: dayEnd } } }),
    ]);
    dailyActivity.push({
      date: dayStart.toISOString().slice(0, 10),
      events,
      logins,
      views,
    });
  }

  // Recent actions breakdown
  const recentActions = await prisma.auditEvent.groupBy({
    by: ['action'],
    where: { actorId: userId, createdAt: { gte: monthAgo } },
    _count: { action: true },
    orderBy: { _count: { action: 'desc' } },
    take: 10,
  });

  return NextResponse.json({
    overview: {
      totalEvents: totalAuditEvents,
      eventsThisWeek,
      eventsThisMonth,
      loginCount,
      loginsThisWeek: loginThisWeek,
      securityEvents: securityEventsCount,
    },
    profileViews: {
      today: profileViewsToday,
      thisWeek: profileViewsWeek,
      total: profileViewsTotal,
    },
    network: {
      followers: followerCount,
      following: followingCount,
      connections: connectionCount,
    },
    dailyActivity,
    topActions: recentActions.map((a) => ({ action: a.action, count: a._count.action })),
  });
}
