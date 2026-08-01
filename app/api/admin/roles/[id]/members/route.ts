import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const { id } = await params;
    const body = await request.json();
    const { userId, assignedById } = body;

    if (!userId) {
      return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
    }

    const existing = await prisma.userRole.findUnique({
      where: { userId_roleId: { userId, roleId: id } },
    });

    if (existing) {
      return NextResponse.json({ error: 'User already has this role' }, { status: 400 });
    }

    const member = await prisma.userRole.create({
      data: {
        userId,
        roleId: id,
        assignedById: assignedById || (session as any).userId,
      },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    });

    return NextResponse.json(member);
  } catch (err: any) {
    console.error('[ADMIN ROLES] Add member error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to add member' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const { id } = await params;
    const body = await request.json();
    const { userId } = body;

    if (!userId) {
      return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
    }

    await prisma.userRole.delete({
      where: { userId_roleId: { userId, roleId: id } },
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[ADMIN ROLES] Remove member error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 });
  }
}
