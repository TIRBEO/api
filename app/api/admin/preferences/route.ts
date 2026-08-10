import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { prisma } from '../../../../lib/db/prisma';

const PREFERENCES_KEY = (userId: string) => `admin:preferences:${userId}`;

export async function GET(request: Request) {
  const session = await requireAdmin(request as any);
  if (session instanceof NextResponse) return session;

  const row = await prisma.setting.findUnique({
    where: { key: PREFERENCES_KEY(session.userId) },
    select: { value: true },
  });
  if (!row) return new NextResponse('Not found', { status: 404 });

  return NextResponse.json(row.value);
}

export async function PUT(request: Request) {
  const session = await requireAdmin(request as any);
  if (session instanceof NextResponse) return session;

  const body: any = await request.json();
  const existing = await prisma.setting.findUnique({
    where: { key: PREFERENCES_KEY(session.userId) },
    select: { value: true },
  });
  const merged = { ...(existing?.value as Record<string, unknown> || {}), ...body };

  await prisma.setting.upsert({
    where: { key: PREFERENCES_KEY(session.userId) },
    update: { value: merged as any },
    create: { key: PREFERENCES_KEY(session.userId), value: merged as any },
  });

  return NextResponse.json(merged);
}
