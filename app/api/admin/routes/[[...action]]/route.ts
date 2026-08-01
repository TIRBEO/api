import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '../../../../../lib/db/prisma';
import { requireRole } from '../../../../../lib/session';

export async function GET(request: NextRequest) {
  const session = await requireRole(request, 'editor');
  if (session instanceof NextResponse) return session;

  const routes = await prisma.route.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json(routes);
}

export async function POST(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const route = await prisma.route.create({
    data: {
      path: body.path,
      method: body.method || 'GET',
      target: body.target || null,
      allowedRoles: body.allowedRoles || ['member'],
      internal: body.internal || false,
      enabled: body.enabled ?? true,
    },
  });
  return NextResponse.json(route, { status: 201 });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const { action } = await params;
  const [id] = action || [];
  if (!id) return new NextResponse('Missing route id', { status: 400 });
  const body = await request.json();
  const route = await prisma.route.update({
    where: { id },
    data: {
      path: body.path,
      method: body.method,
      target: body.target,
      allowedRoles: body.allowedRoles,
      internal: body.internal,
      enabled: body.enabled,
    },
  });
  return NextResponse.json(route);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const { action } = await params;
  const [id] = action || [];
  if (!id) return new NextResponse('Missing route id', { status: 400 });
  await prisma.route.delete({ where: { id } });
  return new NextResponse('Deleted', { status: 200 });
}

export { PUT as PATCH };
