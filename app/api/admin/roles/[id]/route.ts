import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';
import { normalizePermissions } from '@/lib/roles';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const { id } = await params;

    const role = await prisma.app_roles.findUnique({
      where: { id },
      include: {
        userRoles: {
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
        },
      },
    });

    if (!role) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }

    return NextResponse.json(role);
  } catch (err: any) {
    console.error('[ADMIN ROLES] Get role error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch role' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const { id } = await params;
    const body = await request.json();
    const { name, description, permissions, color, icon, isSystem } = body;

    const role = await prisma.app_roles.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(permissions !== undefined && { permissions: normalizePermissions(permissions) }),
        ...(color && { color }),
        ...(icon && { icon }),
        ...(isSystem !== undefined && { isSystem }),
      },
    });

    return NextResponse.json(role);
  } catch (err: any) {
    console.error('[ADMIN ROLES] Update role error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to update role' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const { id } = await params;
    const role = await prisma.app_roles.findUnique({
      where: { id },
    });

    if (!role) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }

    if (role.isSystem) {
      return NextResponse.json({ error: 'Cannot delete system roles' }, { status: 403 });
    }

    await prisma.userRole.deleteMany({
      where: { roleId: id },
    });

    await prisma.app_roles.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[ADMIN ROLES] Delete role error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to delete role' }, { status: 500 });
  }
}
