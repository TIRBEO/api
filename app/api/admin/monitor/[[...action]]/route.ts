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
    const logs = await prisma.auditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    return NextResponse.json(logs);
  }
  if (first === 'blocked') {
    const blocked = await prisma.blocklist.findMany({ orderBy: { createdAt: 'desc' } });
    return NextResponse.json(blocked);
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const { action } = await params;
  const [first] = action;
  if (first === 'blocked') {
    const body: any = await request.json();
    const entry = await prisma.blocklist.create({
      data: {
        targetType: 'ip',
        targetId: body.ip,
        reason: body.reason || null,
        blockedBy: session.userId,
      },
    });
    return NextResponse.json(entry, { status: 201 });
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const { action } = await params;
  const [first] = action;
  if (first === 'blocked') {
    const body: any = await request.json();
    if (body.id) {
      await prisma.blocklist.delete({ where: { id: body.id } });
    } else if (body.ip) {
      await prisma.blocklist.deleteMany({ where: { targetType: 'ip', targetId: body.ip } });
    } else if (body.userId) {
      await prisma.blocklist.deleteMany({ where: { targetType: 'user', targetId: body.userId } });
    }
    return NextResponse.json({ error: 'Blocked removed' }, { status: 200 });
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
