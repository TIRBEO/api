import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requirePermission } from '@/features/auth/http-guards';
import { trackQuery } from '@/infrastructure/observability/queryMonitor';

/* The security posture, and only what can actually be measured.
 *
 * The version this replaces scored five factors out of 100. Three of them —
 * Password Policy, Session Security, Rate Limiting — were literals
 * (`const passwordScore = 18; // Assuming strong password policy`). They were
 * not observations of anything; they were an assumption given a number, and
 * the headline score and its `threatLevel` were built on them. An operator
 * reading "83/100, low threat" was being reassured by arithmetic, not by the
 * platform.
 *
 * So: a factor is reported when a query produced it and it is named as
 * `measured`, and everything this build cannot observe is listed under
 * `unmeasured` with the reason. The score is the measured part of the posture,
 * `scoreMax` says what it is out of, and nothing is divided by a hundred that
 * was not counted.
 *
 * Window: every event aggregate below is the last 30 days and says so, because
 * a count of a log with no window is a number that changes meaning when the log
 * is rotated. */

const WINDOW_DAYS = 30;

/** A factor computed from a query. */
type MeasuredFactor = {
  name: string;
  score: number;
  maxScore: number;
  status: 'good' | 'warning' | 'critical';
  /** The ratio the score came from, as a percentage — so the screen can show
      the measurement and the verdict separately. */
  observed: number;
  detail: string;
};

/** A factor the old screen drew a number for, now reported as unmeasured. */
const UNMEASURED = [
  {
    name: 'Password Policy',
    why: 'The schema stores a hash. Nothing records the length or character classes a password was built from, so strength cannot be read from a row.',
  },
  {
    name: 'Session Security',
    why: 'Active and revoked sessions are counted below, but there is no policy value to compare them against — rotation and idle-timeout live in code, not in a table this route can query.',
  },
  {
    name: 'Rate Limiting',
    why: 'The limiter keeps its counters in Redis. They are reachable through the rate-limit endpoint, which reports them directly rather than folding them into a score here.',
  },
  {
    name: 'Blocklist Coverage',
    why: 'Blocked addresses are counted below. A count of the blocklist says nothing about what should have been on it, which is what "coverage" would have to mean to be a score.',
  },
];

function statusFor(ratio: number): MeasuredFactor['status'] {
  return ratio >= 75 ? 'good' : ratio >= 40 ? 'warning' : 'critical';
}

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, 'security.read');
  if (session instanceof NextResponse) return session;

  try {
    const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [totalUsers, usersWith2FA, activeSessions, revokedSessions, blockedIPs, blockedUsers] =
      await Promise.all([
        prisma.user.count(),
        prisma.userSecurity.count({ where: { totpEnabled: true } }),
        prisma.userSession.count({ where: { status: 'active' } }),
        prisma.userSession.count({ where: { status: 'revoked' } }),
        prisma.blocklist.count({ where: { targetType: 'ip' } }),
        prisma.blocklist.count({ where: { targetType: 'user' } }),
      ]);

    /* The one genuine ratio available: how many accounts protect themselves
       with a second factor. Scored out of 20 the way the previous build scored
       it, so the number means the same thing it always did — the difference is
       that nothing else on this screen is now pretending to be measured. */
    const adoption = totalUsers > 0 ? (usersWith2FA / totalUsers) * 100 : 0;
    const measured: MeasuredFactor[] = [
      {
        name: '2FA Adoption',
        score: Math.min(20, Math.round(adoption / 5)),
        maxScore: 20,
        status: statusFor(adoption),
        observed: Math.round(adoption),
        detail: `${usersWith2FA} of ${totalUsers} accounts have a second factor`,
      },
    ];

    const score = measured.reduce((sum, f) => sum + f.score, 0);
    const scoreMax = measured.reduce((sum, f) => sum + f.maxScore, 0);
    const posture = scoreMax > 0 ? (score / scoreMax) * 100 : 0;

    // ActivityEvent was consolidated into one log (SecurityEvent is gone):
    // `kind` is the event type, and the shape the panel reads is kept here.
    const [recentCritical, ipCounts, eventTypes] = await Promise.all([
      trackQuery('activity_events_by_severity_created', () =>
        prisma.activityEvent.findMany({
          where: { severity: 'critical', createdAt: { gte: windowStart } },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            severity: true,
            kind: true,
            title: true,
            detail: true,
            metadata: true,
            createdAt: true,
            ipAddress: true,
            // A user's name is on user_profile; selecting `name` off the users
            // row fails the query and this whole endpoint answers 500.
            user: { select: { email: true, profile: { select: { name: true } } } },
          },
        }).then((rows) => rows.map((r: any) => ({ ...r, eventType: r.kind }))),
      ),
      trackQuery('activity_events_group_by_ip', () =>
        prisma.activityEvent.groupBy({
          by: ['ipAddress'],
          where: { createdAt: { gte: windowStart }, ipAddress: { not: null } },
          _count: { id: true },
          _max: { createdAt: true },
          orderBy: { _count: { id: 'desc' } },
          take: 10,
        }),
      ),
      trackQuery('activity_events_group_by_type', () =>
        prisma.activityEvent.groupBy({
          by: ['kind'],
          where: { createdAt: { gte: windowStart } },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
          take: 10,
        }),
      ),
    ]);

    /* The previous build set `lastSeen: new Date()` — the moment of the request,
       dressed up as a fact about the address. `_max(createdAt)` is the real one. */
    const topIPs = ipCounts.map((ip) => ({
      ip: ip.ipAddress || 'not recorded',
      count: ip._count.id,
      lastSeen: ip._max.createdAt?.toISOString() ?? null,
    }));

    const criticalEvents = recentCritical.map((e: any) => ({
      ...e,
      user: e.user ? { email: e.user.email, name: e.user.profile?.name ?? null } : null,
    }));

    const topEventTypes = eventTypes.map((et) => ({ type: et.kind, count: et._count.id }));

    return NextResponse.json(
      {
        windowDays: WINDOW_DAYS,
        score,
        scoreMax,
        posture: Math.round(posture),
        measured,
        unmeasured: UNMEASURED,
        recentCritical: criticalEvents,
        topIPs,
        topEventTypes,
        counts: {
          totalUsers,
          usersWith2FA,
          activeSessions,
          revokedSessions,
          blockedIPs,
          blockedUsers,
          criticalLastWindow: criticalEvents.length,
        },
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (err: any) {
    console.error('[SECURITY_SCORE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to calculate security score' }, { status: 500 });
  }
}
