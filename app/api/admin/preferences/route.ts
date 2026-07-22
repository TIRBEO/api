import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '../../../../lib/auth/session';
import { prisma } from '../../../../lib/db/prisma';

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request as any);
  if (!session) return new NextResponse('Unauthorized', { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { preferences: true },
  });
  if (!user) return new NextResponse('Not found', { status: 404 });

  return NextResponse.json(user.preferences);
}

export async function PUT(request: Request) {
  const session = await getSessionFromRequest(request as any);
  if (!session) return new NextResponse('Unauthorized', { status: 401 });

  const body = await request.json();
  // Merge preferences instead of replacing
  const existing = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { preferences: true },
  });
  const merged = { ...(existing?.preferences as Record<string, unknown> || {}), ...body };

  await prisma.user.update({
    where: { id: session.userId },
    data: { preferences: merged },
  });

  return NextResponse.json(merged);
}
