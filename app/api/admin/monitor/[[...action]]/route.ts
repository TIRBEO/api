import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requireRole } from '@/features/auth/http-guards';
import { listBlocks, blockTarget, unblockTarget } from '@/features/security/security';

export async function GET(request: NextRequest, { params }: { params: Promise<{ action?: string[] }> }) {
  const session = await requireRole(request, 'editor');
  if (session instanceof NextResponse) return session;

  const { action = [] } = await params;
  const [first] = action;
  if (first === 'logs') {
    const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 200, 1000);
    const logs = await prisma.activityEvent.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    return NextResponse.json(logs);
  }
  if (first === 'blocked') {
    const { items } = await listBlocks({ limit: 1000 });
    return NextResponse.json(items);
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ action?: string[] }> }) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const { action = [] } = await params;
  const [first] = action;
  if (first === 'blocked') {
    const body: any = await request.json();
    if (!body?.ip) return NextResponse.json({ error: 'ip is required' }, { status: 400 });
    await blockTarget({
      targetType: 'ip',
      targetId: body.ip,
      reason: body.reason || null,
      blockedBy: session.userId,
    });
    const { items } = await listBlocks({ targetType: 'ip', limit: 1000 });
    const entry = items.find((e: any) => e.targetId === body.ip) || null;
    return NextResponse.json(entry, { status: 201 });
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ action?: string[] }> }) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const { action = [] } = await params;
  const [first] = action;
  if (first === 'blocked') {
    const body: any = await request.json();
    // Redis stores one entry per targetType:targetId (no stable id), so unblock
    // by target. `id` is accepted as "<type>:<value>" for older callers.
    if (body?.id && String(body.id).includes(':')) {
      const [targetType, ...rest] = String(body.id).split(':');
      await unblockTarget(targetType, rest.join(':'));
    } else if (body?.ip) {
      await unblockTarget('ip', body.ip);
    } else if (body?.userId) {
      await unblockTarget('user', body.userId);
    }
    return NextResponse.json({ ok: true, message: 'Blocked removed' });
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
