import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '../../../../../lib/db/prisma';
import { requireRole } from '../../../../../lib/session';

export async function GET(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const session = await requireRole(request, 'editor');
  if (session instanceof NextResponse) return session;

  const { action } = await params;
  const [first] = action;
  if (first === 'logs') {
    const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 200, 1000);
    const logs = await prisma.log.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    return NextResponse.json(logs);
  }
  if (first === 'blocked') {
    const blocked = await prisma.blocklist.findMany({ orderBy: { createdAt: 'desc' } });
    return NextResponse.json(blocked);
  }
  return new NextResponse('Not found', { status: 404 });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const { action } = await params;
  const [first] = action;
  if (first === 'blocked') {
    const body = await request.json();
    const entry = await prisma.blocklist.create({
      data: {
        type: body.type || 'ip',
        value: body.value || body.ip || body.userId || '',
        reason: body.reason || null,
        addedById: session.userId,
      },
    });
    return NextResponse.json(entry, { status: 201 });
  }
  return new NextResponse('Not found', { status: 404 });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const { action } = await params;
  const [first] = action;
  if (first === 'blocked') {
    const body = await request.json();
    if (body.id) {
      await prisma.blocklist.delete({ where: { id: body.id } });
    } else if (body.value) {
      await prisma.blocklist.deleteMany({
        where: { type: body.type || 'ip', value: body.value },
      });
    }
    return new NextResponse('Blocked removed', { status: 200 });
  }
  return new NextResponse('Not found', { status: 404 });
}
