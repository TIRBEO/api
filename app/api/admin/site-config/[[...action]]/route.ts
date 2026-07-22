import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '../../../../../lib/db/prisma';
import { requireRole } from '../../../../../lib/session';
import { cachedJson } from '../../../../../lib/response';

export async function GET(request: NextRequest) {
  const session = await requireRole(request, 'editor');
  if (session instanceof NextResponse) return session;

  const { searchParams } = new URL(request.url);
  const app = searchParams.get('app');

  if (app) {
    const config = await prisma.siteConfig.findUnique({ where: { app } });
    return cachedJson(config || { app, config: {} }, { ttl: 10, swr: 60 });
  }

  const all = await prisma.siteConfig.findMany({ orderBy: { app: 'asc' } });
  return cachedJson(all, { ttl: 10, swr: 60 });
}

export async function PUT(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const { searchParams } = new URL(request.url);
  const app = searchParams.get('app');
  if (!app) return new NextResponse('Missing app query param', { status: 400 });

  const body = await request.json();

  const config = await prisma.siteConfig.upsert({
    where: { app },
    create: {
      app,
      config: body.config || {},
      updatedBy: session.userId,
    },
    update: {
      config: body.config || {},
      updatedBy: session.userId,
    },
  });

  return NextResponse.json(config);
}
