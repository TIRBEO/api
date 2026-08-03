import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from './db/prisma';
import { requireAdmin, requireRole, canManageRole, getAdminRole } from './session';
import { cachedJson, jsonUnauthorized, jsonForbidden } from './response';
import { createAuditEvent } from './audit';
import { invalidateReservedCache } from './reservedCache';

export async function listUsers(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const search = request.nextUrl.searchParams.get('search') || '';
  const page = Number(request.nextUrl.searchParams.get('page')) || 1;
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 100, 500);

  const where: any = search
    ? { OR: [{ email: { contains: search } }, { name: { contains: search } }] }
    : {};

  if (session.adminRole !== 'super_admin') {
    where.adminRole = { not: 'super_admin' };
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        photoUrl: true,
        adminRole: true,
        isBanned: true,
        isSuspended: true,
        createdAt: true,
        preferences: true,
        roles: {
          select: { role: { select: { id: true, name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  const mapped = users.map(u => ({
    ...u,
    status: u.isBanned ? 'BANNED' : u.isSuspended ? 'SUSPENDED' : 'ACTIVE',
    roles: u.roles.map(a => a.role),
    signupConsent: (u.preferences as Record<string, any> | null | undefined)?.signupConsent ?? null,
    roleAssignments: undefined,
  }));

  return NextResponse.json({ users: mapped, total, page, limit });
}

export async function getUserDetail(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      photoUrl: true,
      adminRole: true,
      isBanned: true,
      isSuspended: true,
      is2FAEnabled: true,
      emailVerified: true,
      createdAt: true,
      updatedAt: true,
      preferences: true,
      _count: { select: { sessions: true, memberships: true, notifications: true } },
      roles: {
        select: { role: { select: { id: true, name: true } } },
      },
      sessions: {
        select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
    },
  });
  if (!user) return new NextResponse('User not found', { status: 404 });
  return NextResponse.json({
    ...user,
    status: user.isBanned ? 'BANNED' : user.isSuspended ? 'SUSPENDED' : 'ACTIVE',
    roles: user.roles.map(a => a.role),
    signupConsent: (user.preferences as Record<string, any> | null | undefined)?.signupConsent ?? null,
    roleAssignments: undefined,
  });
}

const updateUserSchema = z.object({
  displayName: z.string().min(1).optional(),
  adminRole: z.enum(['super_admin', 'admin', 'manager', 'editor']).nullable().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']).optional(),
});

export async function updateUser(request: NextRequest, userId: string) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });

  const body = await request.json();
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) return new NextResponse('Invalid payload', { status: 400 });

  if (parsed.data.adminRole !== undefined) {
    if (!canManageRole(session.adminRole, existing.adminRole)) {
      return new NextResponse('Cannot change role of this user', { status: 403 });
    }
  }

  const data: any = {};
  if (parsed.data.displayName !== undefined) data.name = parsed.data.displayName;
  if (parsed.data.adminRole !== undefined) data.adminRole = parsed.data.adminRole;
  if (parsed.data.status !== undefined) {
    if (parsed.data.status === 'BANNED') {
      data.isBanned = true;
      data.isSuspended = false;
    } else if (parsed.data.status === 'SUSPENDED') {
      data.isSuspended = true;
      data.isBanned = false;
    } else {
      data.isBanned = false;
      data.isSuspended = false;
      data.suspendedUntil = null;
      data.suspendReason = null;
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      email: true,
      name: true,
      photoUrl: true,
      adminRole: true,
      isBanned: true,
      isSuspended: true,
    },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.updated',
    targetType: 'user',
    targetId: userId,
    metadata: { changes: parsed.data, previous: { adminRole: existing.adminRole } },
  });

  return NextResponse.json({
    ...updated,
    status: updated.isBanned ? 'BANNED' : updated.isSuspended ? 'SUSPENDED' : 'ACTIVE',
  });
}

export async function deleteUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });

  await prisma.user.delete({ where: { id: userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.deleted',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email, displayName: existing.name },
  });

  return new NextResponse('User deleted', { status: 200 });
}

export async function listOrganizations(request: NextRequest) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const page = Number(request.nextUrl.searchParams.get('page')) || 1;
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 100, 500);

  const [organizations, total] = await Promise.all([
    prisma.workspace.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        ownerId: true,
        createdAt: true,
        users: { select: { id: true, email: true, name: true } },
        _count: { select: { memberships: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.workspace.count(),
  ]);

  return NextResponse.json({ organizations, total, page, limit });
}

export async function deleteOrganization(request: NextRequest, orgId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.workspace.findUnique({ where: { id: orgId } });
  if (!existing) return new NextResponse('Organization not found', { status: 404 });

  await prisma.workspace.delete({ where: { id: orgId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'workspace.deleted',
    targetType: 'workspace',
    targetId: orgId,
    metadata: { name: existing.name, slug: existing.slug },
  });

  return new NextResponse('Organization deleted', { status: 200 });
}

export async function banUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });
  if (existing.adminRole === 'super_admin') return new NextResponse('Cannot ban a super admin', { status: 403 });

  const { reason } = await request.json().catch(() => ({}));

  await prisma.user.update({ where: { id: userId }, data: { isBanned: true, isSuspended: false, suspendReason: reason || 'No reason provided', suspendedUntil: null } });
  await prisma.session.deleteMany({ where: { userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.banned',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email, reason: reason || 'No reason provided' },
  });

  return NextResponse.json({ message: 'User banned' });
}

export async function unbanUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });

  await prisma.user.update({ where: { id: userId }, data: { isBanned: false, isSuspended: false, suspendedUntil: null, suspendReason: null } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.unbanned',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email },
  });

  return NextResponse.json({ message: 'User unbanned' });
}

export async function suspendUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });
  if (existing.adminRole === 'super_admin') return new NextResponse('Cannot suspend a super admin', { status: 403 });

  const { reason } = await request.json().catch(() => ({}));

  await prisma.user.update({ where: { id: userId }, data: { isSuspended: true, isBanned: false, suspendReason: reason || 'No reason provided' } });
  await prisma.session.deleteMany({ where: { userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.suspended',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email, reason: reason || 'No reason provided' },
  });

  return NextResponse.json({ message: 'User suspended' });
}

export async function unsuspendUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });

  await prisma.user.update({ where: { id: userId }, data: { isSuspended: false, suspendedUntil: null, suspendReason: null } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.unsuspended',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email },
  });

  return NextResponse.json({ message: 'User unsuspended' });
}

export async function listOrganizationMembers(request: NextRequest, orgId: string) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const org = await prisma.workspace.findUnique({ where: { id: orgId } });
  if (!org) return new NextResponse('Organization not found', { status: 404 });

  const members = await prisma.membership.findMany({
    where: { workspaceId: orgId },
    include: { users: { select: { id: true, email: true, name: true, photoUrl: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({ members, organization: { id: org.id, name: org.name, slug: org.slug } });
}

export async function addOrganizationMember(request: NextRequest, orgId: string) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const { email, role } = body;
  if (!email) return new NextResponse('email required', { status: 400 });

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return new NextResponse('User not found', { status: 404 });

  const existing = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId: orgId } },
  });
  if (existing) return new NextResponse('User is already a member', { status: 409 });

  const membership = await prisma.membership.create({
    data: { userId: user.id, workspaceId: orgId, role: role === 'ADMIN' ? 'ADMIN' : 'MEMBER' },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'workspace.member_added',
    targetType: 'workspace',
    targetId: orgId,
    metadata: { addedUserId: user.id, addedEmail: email, role: membership.role },
  });

  return NextResponse.json(membership, { status: 201 });
}

export async function removeOrganizationMember(request: NextRequest, orgId: string) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const { userId } = body;
  if (!userId) return new NextResponse('userId required', { status: 400 });

  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: orgId } },
  });
  if (!membership) return new NextResponse('Member not found', { status: 404 });

  await prisma.membership.delete({ where: { id: membership.id } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'workspace.member_removed',
    targetType: 'workspace',
    targetId: orgId,
    metadata: { removedUserId: userId },
  });

  return new NextResponse('Member removed', { status: 200 });
}

export async function getStats(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const [userCount, orgCount, routeCount, auditCount, blocklistCount] = await Promise.all([
    prisma.user.count(),
    prisma.workspace.count(),
    prisma.route.count(),
    prisma.auditEvent.count(),
    prisma.blocklist.count(),
  ]);

  const adminUsers = await prisma.user.findMany({
    where: { adminRole: { not: null } },
    select: { id: true, email: true, name: true, adminRole: true },
  });

  return cachedJson({
    counts: { users: userCount, organizations: orgCount, routes: routeCount, auditEvents: auditCount, blocked: blocklistCount },
    adminUsers,
  }, { ttl: 15, swr: 120 });
}

export async function updateUserRoles(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const { roleIds } = body;
  if (!Array.isArray(roleIds)) {
    return new NextResponse('roleIds array required', { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });

  const existingAssignments = await prisma.userRole.findMany({
    where: { userId },
    select: { roleId: true },
  });

  await prisma.userRole.deleteMany({ where: { userId } });

  if (roleIds.length > 0) {
    const validRoles = await prisma.app_roles.findMany({
      where: { id: { in: roleIds }, isSystem: false },
      select: { id: true },
    });
    const validIds = new Set(validRoles.map(r => r.id));
    const toCreate = roleIds.filter((id: string) => validIds.has(id));
    if (toCreate.length > 0) {
      await prisma.userRole.createMany({
        data: toCreate.map((roleId: string) => ({ userId, roleId })),
      });
    }
  }

  const updated = await prisma.userRole.findMany({
    where: { userId },
    include: { role: { select: { id: true, name: true } } },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.roles_updated',
    targetType: 'user',
    targetId: userId,
    metadata: { roleIds, previousRoleIds: existingAssignments.map(a => a.roleId) },
  });

  return NextResponse.json({ roles: updated.map(a => a.role) });
}

export async function seedAdminHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const { email, adminRole, password } = body;

  if (!email || !adminRole) {
    return new NextResponse('email and adminRole required', { status: 400 });
  }

  if (!process.env.ADMIN_SEED_EMAIL) {
    return new NextResponse('Seed endpoint is disabled. Set ADMIN_SEED_EMAIL env var.', { status: 403 });
  }
  if (email !== process.env.ADMIN_SEED_EMAIL) {
    return jsonForbidden();
  }

  const { hashPassword: hashPw } = await import('./auth/password');
  const passwordHash = password ? await hashPw(password) : undefined;

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { email, passwordHash: passwordHash || '', name: email.split('@')[0], adminRole },
    });
    return NextResponse.json({ message: `User ${email} created with role ${adminRole}` });
  }

  const updateData: Record<string, unknown> = { adminRole };
  if (passwordHash) updateData.passwordHash = passwordHash;
  await prisma.user.update({ where: { email }, data: updateData });

  return NextResponse.json({ message: `User ${email} promoted to ${adminRole}${password ? ' with new password' : ''}` });
}

export async function resetUserPassword(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const { password } = body;
  if (!password || typeof password !== 'string' || password.length < 8) {
    return new NextResponse('Password must be at least 8 characters', { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });

  const { hashPassword } = await import('./auth/password');
  const passwordHash = await hashPassword(password);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'password.reset',
    targetType: 'user',
    targetId: userId,
    metadata: { from: 'admin_panel', resetBy: 'super_admin' },
  });

  return NextResponse.json({ message: 'Password reset successfully' });
}

export async function reservedAddressesHandler(request: NextRequest) {
  try {
    const admin = await requireAdmin(request);
    if (admin instanceof NextResponse) return admin;

    if (request.method === 'GET') {
      const { searchParams } = request.nextUrl;
      const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
      const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50')));
      const search = searchParams.get('search') || '';
      const category = searchParams.get('category') || '';
      const level = searchParams.get('level') || '';

      const where: any = {};
      if (search) where.address = { contains: search.toLowerCase() };
      if (category) where.category = category;
      if (level) where.level = level;

      const items = await prisma.reservedAddress.findMany({
        where,
        orderBy: [{ category: 'asc' }, { address: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: { id: true, address: true, reason: true, level: true, category: true, createdAt: true },
      });
      const total = await prisma.reservedAddress.count({ where });

      return NextResponse.json({ items, total, page, limit });
    }

    if (request.method === 'POST') {
      if (admin.adminRole !== 'super_admin') {
        return new NextResponse('Only super_admin can manage reserved addresses', { status: 403 });
      }

      const body = await request.json();
      const { address, reason, level, category } = body;

      if (!address || typeof address !== 'string') {
        return new NextResponse('Address is required', { status: 400 });
      }

      const clean = address.toLowerCase().trim().replace(/[#@\s]/g, '');
      if (!/^[a-z0-9][a-z0-9._-]{0,30}[a-z0-9]$/.test(clean) && clean.length >= 2) {
        return new NextResponse('Invalid address format', { status: 400 });
      }

      const exists = await prisma.reservedAddress.findUnique({ where: { address: clean } });
      if (exists) return new NextResponse('Already reserved', { status: 409 });

      await prisma.reservedAddress.create({
        data: {
          address: clean,
          reason: reason || 'reserved',
          level: level || 'hard',
          category: category || 'custom',
          addedById: admin.userId,
        },
      });

      await createAuditEvent({
        actorId: admin.userId,
        action: 'reserved_address.added',
        targetType: 'reserved_address',
        targetId: clean,
        metadata: { reason, level, category },
      });

      invalidateReservedCache();
      return NextResponse.json({ ok: true, address: clean });
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[RESERVED ADDRESSES]', err?.message || err);
    return new NextResponse('Failed to manage reserved addresses', { status: 500 });
  }
}

export async function reservedAddressDeleteHandler(request: NextRequest, addressId: string) {
  try {
    const admin = await requireAdmin(request);
    if (admin instanceof NextResponse) return admin;

    if (admin.adminRole !== 'super_admin') {
      return new NextResponse('Only super_admin can remove reserved addresses', { status: 403 });
    }

    const item = await prisma.reservedAddress.findUnique({ where: { id: addressId } });
    if (!item) return new NextResponse('Not found', { status: 404 });

    if (item.category === 'system') {
      return new NextResponse('System reserved addresses cannot be removed', { status: 403 });
    }

    await prisma.reservedAddress.delete({ where: { id: addressId } });

    await createAuditEvent({
      actorId: admin.userId,
      action: 'reserved_address.removed',
      targetType: 'reserved_address',
      targetId: item.address,
      metadata: { category: item.category, level: item.level },
    });

    invalidateReservedCache();
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[RESERVED ADDRESS DELETE]', err?.message || err);
    return new NextResponse('Failed to delete reserved address', { status: 500 });
  }
}

// ─── Admin Forms Supervision ──────────────────────────────────

export async function listAdminForms(request: NextRequest) {
  const admin = await requireRole(request, 'manager');
  if (admin instanceof NextResponse) return admin;

  const search = request.nextUrl.searchParams.get('search') || '';
  const status = request.nextUrl.searchParams.get('status') || '';
  const page = Number(request.nextUrl.searchParams.get('page')) || 1;
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 50, 200);
  const skip = (page - 1) * limit;

  const where: any = {};
  if (search) where.title = { contains: search, mode: 'insensitive' };
  if (status) where.status = status;

  const [forms, total] = await Promise.all([
    prisma.form.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        user: { select: { id: true, email: true, name: true } },
        _count: { select: { responses: true, fields: true } },
      },
    }),
    prisma.form.count({ where }),
  ]);

  return NextResponse.json({ forms, total, page, limit });
}

export async function getAdminFormDetails(request: NextRequest, formId: string) {
  const admin = await requireRole(request, 'manager');
  if (admin instanceof NextResponse) return admin;

  const form = await prisma.form.findUnique({
    where: { id: formId },
    include: {
      user: { select: { id: true, email: true, name: true } },
      fields: { orderBy: { order: 'asc' } },
      pages: { orderBy: { order: 'asc' }, include: { fields: { orderBy: { order: 'asc' } } } },
      collaborators: { include: { user: { select: { id: true, email: true, name: true } } } },
      _count: { select: { responses: true } },
    },
  });

  if (!form) return new NextResponse('Form not found', { status: 404 });
  return NextResponse.json(form);
}

export async function listAdminResponses(request: NextRequest) {
  const admin = await requireRole(request, 'manager');
  if (admin instanceof NextResponse) return admin;

  const formId = request.nextUrl.searchParams.get('formId') || '';
  const page = Number(request.nextUrl.searchParams.get('page')) || 1;
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 50, 200);
  const skip = (page - 1) * limit;

  const where: any = {};
  if (formId) where.formId = formId;

  const [responses, total] = await Promise.all([
    prisma.response.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        form: { select: { id: true, title: true, publicId: true } },
        answers: { include: { field: { select: { id: true, label: true, type: true } } } },
      },
    }),
    prisma.response.count({ where }),
  ]);

  return NextResponse.json({ responses, total, page, limit });
}

export async function getAdminResponseDetails(request: NextRequest, formId: string, responseId: string) {
  const admin = await requireRole(request, 'manager');
  if (admin instanceof NextResponse) return admin;

  const response = await prisma.response.findFirst({
    where: { id: responseId, formId },
    include: {
      form: { select: { id: true, title: true, publicId: true, user: { select: { email: true, name: true } } } },
      answers: { include: { field: { select: { id: true, label: true, type: true, options: true } } } },
      notes: { orderBy: { createdAt: 'desc' }, include: { user: { select: { id: true, email: true, name: true } } } },
    },
  });

  if (!response) return new NextResponse('Response not found', { status: 404 });
  return NextResponse.json(response);
}
