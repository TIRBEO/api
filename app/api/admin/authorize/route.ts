import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { getSessionFromToken } from '../../../../lib/auth/session';
import { COOKIE_NAME } from '../../../../lib/auth/jwt';

export async function GET(request: NextRequest) {
  const cookieToken = request.cookies.get(COOKIE_NAME)?.value;
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const token = cookieToken || bearerToken;
  if (!token) return new NextResponse('Unauthorized', { status: 401 });

  const session = await getSessionFromToken(token);
  if (!session) return new NextResponse('Unauthorized', { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { adminRole: true, isBanned: true, isSuspended: true },
  });
  if (!user) return new NextResponse('Unauthorized', { status: 401 });

  return NextResponse.json({
    adminRole: user.adminRole || null,
    isBanned: user.isBanned,
    isSuspended: user.isSuspended,
  });
}
