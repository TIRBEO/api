import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '../../../../lib/auth/session';
import { prisma } from '../../../../lib/db/prisma';

export async function POST(request: Request) {
  const session = await getSessionFromRequest(request as any);
  if (!session) return new NextResponse('Unauthorized', { status: 401 });

  await prisma.user.update({
    where: { id: session.userId },
    data: { lastActiveAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
