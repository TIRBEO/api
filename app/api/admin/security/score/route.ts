import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/db/prisma';
import { requireAdmin } from '../../../../../lib/session';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const [
    totalUsers,
    usersWith2FA,
    totalSessions,
    activeSessions,
    recentSecurityEvents,
    securityEventCount,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { is2FAEnabled: true } }),
    prisma.session.count(),
    prisma.session.count({ where: { status: 'active' } }),
    prisma.securityEvent.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      select: { eventType: true, severity: true },
    }),
    prisma.securityEvent.count({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    }),
  ]);

  const twoFaAdoption = totalUsers > 0 ? (usersWith2FA / totalUsers) * 100 : 100;
  const twoFaScore = Math.min(twoFaAdoption, 100);

  const activeSessionRatio = totalSessions > 0 ? (activeSessions / totalSessions) * 100 : 100;
  const sessionScore = Math.min(activeSessionRatio + 10, 100);

  const breachScore = Math.max(100 - securityEventCount * 5, 0);

  const score = Math.round((twoFaScore * 0.4) + (sessionScore * 0.3) + (breachScore * 0.3));
  const finalScore = Math.max(0, Math.min(100, score));

  const grade = finalScore >= 80 ? 'A' : finalScore >= 60 ? 'B' : finalScore >= 40 ? 'C' : finalScore >= 20 ? 'D' : 'F';

  return NextResponse.json({
    score: finalScore,
    grade,
    metrics: {
      totalUsers,
      usersWith2FA,
      twoFaAdoption: Math.round(twoFaAdoption),
      totalSessions,
      activeSessions,
      recentSecurityEvents: securityEventCount,
      events: recentSecurityEvents.slice(0, 10),
    },
  });
}
