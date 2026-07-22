import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { getSession } from '../../../../lib/session';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

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
