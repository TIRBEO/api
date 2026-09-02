import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getSessionFromRequest } from '@/lib/auth/session';

// GET /api/forms/stats — Get forms stats for the current user
export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const [userForms, userSubmissions, totalUsersWithForms] = await Promise.all([
      prisma.form.count({ where: { userId: session.userId } }),
      prisma.formSubmission.count({ where: { form: { userId: session.userId } } }),
      prisma.form.groupBy({ by: ['userId'], _count: true }).then(r => r.length),
    ]);

    return NextResponse.json({
      totalForms: userForms,
      totalSubmissions: userSubmissions,
      totalUsers: totalUsersWithForms,
    });
  } catch (error: any) {
    console.error('[FORMS:STATS] error:', error?.message);
    return NextResponse.json({ totalForms: 0, totalSubmissions: 0, totalUsers: 0 });
  }
}
