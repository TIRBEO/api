import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getSessionFromRequest } from '@/lib/auth/session';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    const { searchParams } = new URL(req.url);
    const days = parseInt(searchParams.get('days') || '30');

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    // Parallelize all three queries instead of sequential awaits
    const [analytics, recentSubmissions, totalCounts] = await Promise.all([
      prisma.formAnalytic.findMany({
        where: { formId: id, date: { gte: startDate } },
        orderBy: { date: 'asc' },
      }),
      prisma.formSubmission.findMany({
        where: { formId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.formSubmission.aggregate({
        where: { formId: id },
        _count: true,
      }),
    ]);

    const totals = analytics.reduce(
      (acc, day) => ({
        views: acc.views + day.views,
        starts: acc.starts + day.starts,
        submissions: acc.submissions + day.submissions,
        failedSubmissions: acc.failedSubmissions + day.failedSubmissions,
      }),
      { views: 0, starts: 0, submissions: 0, failedSubmissions: 0 }
    );

    const conversionRate = totals.views > 0 ? (totals.submissions / totals.views) * 100 : 0;
    const completionRate = totals.starts > 0 ? (totals.submissions / totals.starts) * 100 : 0;

    return NextResponse.json({
      analytics, totals,
      conversionRate: Math.round(conversionRate * 10) / 10,
      completionRate: Math.round(completionRate * 10) / 10,
      recentSubmissions,
      totalSubmissions: totalCounts._count,
    });
  } catch (error: any) {
    console.error('[FORMS] GET analytics error:', error?.message);
    return NextResponse.json({ error: 'Failed to load analytics' }, { status: 500 });
  }
}
