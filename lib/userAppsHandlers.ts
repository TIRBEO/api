import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';

export async function userAppsHandler(request: NextRequest) {
  const session = await getSession(request);
  if (!session?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.userId;
  const method = request.method;

  if (method === 'GET') {
    const apps = await prisma.user_apps.findMany({
      where: { userId },
      orderBy: { sortOrder: 'asc' },
    });
    return NextResponse.json({ apps });
  }

  if (method === 'POST') {
    const body = await request.json();
    const { name, description, url, icon, color } = body;
    if (!name?.trim() || !url?.trim()) {
      return NextResponse.json({ error: 'Name and URL are required' }, { status: 400 });
    }
    const maxOrder = await prisma.user_apps.aggregate({
      where: { userId },
      _max: { sortOrder: true },
    });
    const app = await prisma.user_apps.create({
      data: {
        userId,
        name: name.trim(),
        description: (description || '').trim(),
        url: url.trim(),
        icon: icon || null,
        color: color || null,
        sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
      },
    });
    return NextResponse.json({ id: app.id, app }, { status: 201 });
  }

  if (method === 'PUT') {
    const body = await request.json();
    const { id, name, description, url, icon, color, status, sortOrder } = body;
    if (!id) {
      return NextResponse.json({ error: 'App ID is required' }, { status: 400 });
    }
    const existing = await prisma.user_apps.findFirst({ where: { id, userId } });
    if (!existing) {
      return NextResponse.json({ error: 'App not found' }, { status: 404 });
    }
    const app = await prisma.user_apps.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description: description.trim() }),
        ...(url !== undefined && { url: url.trim() }),
        ...(icon !== undefined && { icon: icon || null }),
        ...(color !== undefined && { color: color || null }),
        ...(status !== undefined && { status }),
        ...(sortOrder !== undefined && { sortOrder }),
      },
    });
    return NextResponse.json({ app });
  }

  if (method === 'DELETE') {
    const body = await request.json();
    const { id } = body;
    if (!id) {
      return NextResponse.json({ error: 'App ID is required' }, { status: 400 });
    }
    const existing = await prisma.user_apps.findFirst({ where: { id, userId } });
    if (!existing) {
      return NextResponse.json({ error: 'App not found' }, { status: 404 });
    }
    await prisma.user_apps.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
