import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../../lib/db/prisma';
import { requireAdmin } from '../../../../../lib/session';
import { PERMISSION_RESOURCES, normalizePermissions } from '../../../../../lib/roles';

const roleSchema = z.object({
  name: z.string().min(1).max(50),
  description: z.string().max(200).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().min(1).max(30).optional(),
  permissions: z.record(z.string(), z.boolean()).optional(),
});

function requireSuperAdmin(session: unknown): NextResponse | null {
  const s = session as { adminRole?: string } | null;
  if (!s || s.adminRole !== 'super_admin') {
    return new NextResponse('Forbidden — super_admin only', { status: 403 });
  }
  return null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;
  const forbidden = requireSuperAdmin(session);
  if (forbidden) return forbidden;

  const { action } = await params;
  const roleId = action?.[0];

  if (roleId) {
    const role = await prisma.app_roles.findUnique({
      where: { id: roleId },
      include: {
        userRoles: {
          include: { user: { select: { id: true, email: true, name: true } } },
        },
      },
    });
    if (!role) return new NextResponse('Role not found', { status: 404 });
    return NextResponse.json(role);
  }

  const roles = await prisma.app_roles.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      userRoles: {
        include: { user: { select: { id: true, email: true, name: true } } },
      },
    },
  });
  return NextResponse.json({ roles, groups: PERMISSION_RESOURCES });
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;
  const forbidden = requireSuperAdmin(session);
  if (forbidden) return forbidden;

  const body = await request.json();
  const parsed = roleSchema.safeParse(body);
  if (!parsed.success) {
    return new NextResponse('Invalid payload: ' + JSON.stringify(parsed.error.flatten()), { status: 400 });
  }

  const existing = await prisma.app_roles.findUnique({ where: { name: parsed.data.name } });
  if (existing) return new NextResponse('Role name already exists', { status: 409 });

  const role = await prisma.app_roles.create({
    data: {
      name: parsed.data.name,
      description: parsed.data.description,
      permissions: parsed.data.permissions ? normalizePermissions(parsed.data.permissions) : {},
      color: parsed.data.color || '#4f7aff',
      icon: parsed.data.icon || 'shield',
      isSystem: false,
    },
  });
  return NextResponse.json(role, { status: 201 });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;
  const forbidden = requireSuperAdmin(session);
  if (forbidden) return forbidden;

  const { action } = await params;
  const roleId = action?.[0];
  if (!roleId) return new NextResponse('Missing role id', { status: 400 });

  const existing = await prisma.app_roles.findUnique({ where: { id: roleId } });
  if (!existing) return new NextResponse('Role not found', { status: 404 });

  const body = await request.json();
  const { permissions } = body;
  if (permissions === undefined) {
    return new NextResponse('Invalid payload', { status: 400 });
  }

  const updated = await prisma.app_roles.update({
    where: { id: roleId },
    data: { permissions: normalizePermissions(permissions) },
  });
  return NextResponse.json(updated);
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;
  const forbidden = requireSuperAdmin(session);
  if (forbidden) return forbidden;

  const { action } = await params;
  const roleId = action?.[0];
  if (!roleId) return new NextResponse('Missing role id', { status: 400 });

  const existing = await prisma.app_roles.findUnique({ where: { id: roleId } });
  if (!existing) return new NextResponse('Role not found', { status: 404 });
  if (existing.isSystem) return new NextResponse('Cannot edit system roles', { status: 400 });

  const body = await request.json();
  const parsed = roleSchema.partial().safeParse(body);
  if (!parsed.success) {
    return new NextResponse('Invalid payload', { status: 400 });
  }

  const updateData = {
    ...(parsed.data.name !== undefined && { name: parsed.data.name }),
    ...(parsed.data.description !== undefined && { description: parsed.data.description }),
    ...(parsed.data.color !== undefined && { color: parsed.data.color }),
    ...(parsed.data.icon !== undefined && { icon: parsed.data.icon }),
    ...(parsed.data.permissions !== undefined && { permissions: parsed.data.permissions }),
  };

  const updated = await prisma.app_roles.update({
    where: { id: roleId },
    data: updateData,
  });
  return NextResponse.json(updated);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ action: string[] }> }) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;
  const forbidden = requireSuperAdmin(session);
  if (forbidden) return forbidden;

  const { action } = await params;
  const roleId = action?.[0];
  if (!roleId) return new NextResponse('Missing role id', { status: 400 });

  const existing = await prisma.app_roles.findUnique({ where: { id: roleId } });
  if (!existing) return new NextResponse('Role not found', { status: 404 });
  if (existing.isSystem) return new NextResponse('Cannot delete system roles', { status: 400 });

  await prisma.app_roles.delete({ where: { id: roleId } });
  return new NextResponse('Role deleted', { status: 200 });
}
