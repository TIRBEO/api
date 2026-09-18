import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requireAdmin } from '@/features/auth/http-guards';

export async function GET(request: NextRequest) {
  try {
    const session = await requireAdmin(request);
    if (session instanceof NextResponse) return session;

    const adminCount = await prisma.user.count({
      where: { adminRole: { not: null } },
    });

    let sessionTableExists = false;
    try {
      await prisma.session.count();
      sessionTableExists = true;
    } catch {
      sessionTableExists = false;
    }

    let dbOk = false;
    try {
      await prisma.$connect();
      dbOk = true;
    } catch {
      dbOk = false;
    }

    return NextResponse.json({
      dbConnected: dbOk,
      sessionTableExists,
      setupRequired: adminCount === 0,
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
