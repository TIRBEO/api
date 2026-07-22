import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from './db/prisma';
import { requireAdmin, requireRole, canManageRole, getAdminRole } from './session';
import { cachedJson } from './response';
import { createAuditEvent } from './audit';

async function auditLog(actorId: string, action: string, entityType: string, entityId: string, metadata?: Record<string, unknown>) {
  await prisma.log.create({
    data: {
      ip: '',
      method: 'ADMIN',
      path: `/admin/${entityType}/${entityId}`,
      userId: actorId,
      status: 0,
    },
  });
  await createAuditEvent({
    actorId,
    action,
    targetType: entityType,
    targetId: entityId,
    metadata,
    severity: action.includes('delete') ? 'warning' : 'info',
  });
}

// ─── Users (super_admin / admin / manager) ───

export async function listUsers(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const search = request.nextUrl.searchParams.get('search') || '';
  const page = Number(request.nextUrl.searchParams.get('page')) || 1;
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 100, 500);

  const where: any = search
    ? { OR: [{ email: { contains: search } }, { name: { contains: search } }] }
    : {};

  // Super admin can see all users; others can only see non-super-admin users
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
        adminRole: true,
        photoUrl: true,
        phoneNumber: true,
        occupation: true,
        createdAt: true,
        lastActiveAt: true,
        isBanned: true,
        isSuspended: true,
        roleAssignments: {
          select: { role: { select: { id: true, name: true, color: true, icon: true } } },
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
    roles: u.roleAssignments.map(a => a.role),
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
      adminRole: true,
      photoUrl: true,
      secondaryEmail: true,
      phoneNumber: true,
      occupation: true,
      bio: true,
      website: true,
      linkedin: true,
      github: true,
      twitter: true,
      country: true,
      timezone: true,
      isBanned: true,
      isSuspended: true,
      is2FAEnabled: true,
      emailVerified: true,
      createdAt: true,
      updatedAt: true,
      lastActiveAt: true,
      _count: { select: { sessions: true, memberships: true, ownedWorkspaces: true, notifications: true } },
      roleAssignments: {
        select: { role: { select: { id: true, name: true, color: true, icon: true } } },
      },
      sessions: {
        select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
    },
  });
  if (!user) return new NextResponse('User not found', { status: 404 });
  return NextResponse.json({ ...user, roles: user.roleAssignments.map(a => a.role), roleAssignments: undefined });
}

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  adminRole: z.enum(['super_admin', 'admin', 'manager', 'editor']).nullable().optional(),
  photoUrl: z.string().url().optional(),
  phoneNumber: z.string().optional(),
  occupation: z.string().optional(),
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

  const updated = await prisma.user.update({
    where: { id: userId },
    data: parsed.data,
    select: {
      id: true,
      email: true,
      name: true,
      adminRole: true,
      photoUrl: true,
      phoneNumber: true,
      occupation: true,
      isBanned: true,
      isSuspended: true,
    },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.updated',
    targetType: 'user',
    targetId: userId,
    metadata: { changes: parsed.data, previous: { adminRole: existing.adminRole, name: existing.name } },
  });

  return NextResponse.json(updated);
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
    severity: 'warning',
    metadata: { email: existing.email, name: existing.name },
  });

  return new NextResponse('User deleted', { status: 200 });
}

// ─── Workspaces (super_admin / admin) ───

export async function listWorkspaces(request: NextRequest) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const page = Number(request.nextUrl.searchParams.get('page')) || 1;
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 100, 500);

  const [workspaces, total] = await Promise.all([
    prisma.workspace.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        ownerId: true,
        createdAt: true,
        owner: { select: { id: true, email: true, name: true } },
        _count: { select: { memberships: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.workspace.count(),
  ]);

  return NextResponse.json({ workspaces, total, page, limit });
}

export async function deleteWorkspace(request: NextRequest, workspaceId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!existing) return new NextResponse('Workspace not found', { status: 404 });

  await prisma.workspace.delete({ where: { id: workspaceId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'workspace.deleted',
    targetType: 'workspace',
    targetId: workspaceId,
    severity: 'warning',
    metadata: { name: existing.name, slug: existing.slug },
  });

  return new NextResponse('Workspace deleted', { status: 200 });
}

// ─── Ban / Suspend (super_admin only) ───

export async function banUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });
  if (existing.adminRole === 'super_admin') return new NextResponse('Cannot ban a super admin', { status: 403 });

  const { reason } = await request.json().catch(() => ({}));

  await prisma.user.update({ where: { id: userId }, data: { isBanned: true } });
  // Invalidate all sessions for banned user
  await prisma.session.deleteMany({ where: { userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.banned',
    targetType: 'user',
    targetId: userId,
    severity: 'warning',
    metadata: { email: existing.email, reason: reason || 'No reason provided' },
  });

  return NextResponse.json({ message: 'User banned', isBanned: true });
}

export async function unbanUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });

  await prisma.user.update({ where: { id: userId }, data: { isBanned: false } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.unbanned',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email },
  });

  return NextResponse.json({ message: 'User unbanned', isBanned: false });
}

export async function suspendUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });
  if (existing.adminRole === 'super_admin') return new NextResponse('Cannot suspend a super admin', { status: 403 });

  const { reason } = await request.json().catch(() => ({}));

  await prisma.user.update({ where: { id: userId }, data: { isSuspended: true } });
  await prisma.session.deleteMany({ where: { userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.suspended',
    targetType: 'user',
    targetId: userId,
    severity: 'warning',
    metadata: { email: existing.email, reason: reason || 'No reason provided' },
  });

  return NextResponse.json({ message: 'User suspended', isSuspended: true });
}

export async function unsuspendUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });

  await prisma.user.update({ where: { id: userId }, data: { isSuspended: false } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.unsuspended',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email },
  });

  return NextResponse.json({ message: 'User unsuspended', isSuspended: false });
}

// ─── Workspace Members ───

export async function listWorkspaceMembers(request: NextRequest, workspaceId: string) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return new NextResponse('Workspace not found', { status: 404 });

  const members = await prisma.membership.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, email: true, name: true, photoUrl: true, lastActiveAt: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({ members, workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug } });
}

export async function addWorkspaceMember(request: NextRequest, workspaceId: string) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const { email, role } = body;
  if (!email) return new NextResponse('email required', { status: 400 });

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return new NextResponse('User not found', { status: 404 });

  const existing = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
  });
  if (existing) return new NextResponse('User is already a member', { status: 409 });

  const membership = await prisma.membership.create({
    data: { userId: user.id, workspaceId, role: role === 'ADMIN' ? 'ADMIN' : 'MEMBER' },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'workspace.member_added',
    targetType: 'workspace',
    targetId: workspaceId,
    metadata: { addedUserId: user.id, addedEmail: email, role: membership.role },
  });

  return NextResponse.json(membership, { status: 201 });
}

export async function removeWorkspaceMember(request: NextRequest, workspaceId: string) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const { userId } = body;
  if (!userId) return new NextResponse('userId required', { status: 400 });

  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  if (!membership) return new NextResponse('Member not found', { status: 404 });

  await prisma.membership.delete({ where: { id: membership.id } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'workspace.member_removed',
    targetType: 'workspace',
    targetId: workspaceId,
    metadata: { removedUserId: userId },
  });

  return new NextResponse('Member removed', { status: 200 });
}

// ─── Stats (all admin roles) ───

export async function getStats(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const [userCount, workspaceCount, routeCount, logCount, blocklistCount] = await Promise.all([
    prisma.user.count(),
    prisma.workspace.count(),
    prisma.route.count(),
    prisma.log.count(),
    prisma.blocklist.count(),
  ]);

  const adminUsers = await prisma.user.findMany({
    where: { adminRole: { not: null } },
    select: { id: true, email: true, name: true, adminRole: true },
  });

  return cachedJson({
    counts: { users: userCount, workspaces: workspaceCount, routes: routeCount, logs: logCount, blocked: blocklistCount },
    adminUsers,
  }, { ttl: 15, swr: 120 });
}

// ─── Seed ───

// ─── User Role Assignment (super_admin only) ───

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

  // Capture existing roles before deletion for audit
  const existingAssignments = await prisma.userRole.findMany({
    where: { userId },
    select: { roleId: true },
  });

  // Delete all existing role assignments
  await prisma.userRole.deleteMany({ where: { userId } });

  // Create new assignments
  if (roleIds.length > 0) {
    const validRoles = await prisma.appRole.findMany({
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
    include: { role: { select: { id: true, name: true, color: true, icon: true } } },
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
  const body = await request.json();
  const { email, adminRole, password, key } = body;

  if (!email || !adminRole) {
    return new NextResponse('email and adminRole required', { status: 400 });
  }

  if (!process.env.ADMIN_SEED_EMAIL) {
    return new NextResponse('Seed endpoint is disabled. Set ADMIN_SEED_EMAIL env var.', { status: 403 });
  }
  if (email !== process.env.ADMIN_SEED_EMAIL) {
    return new NextResponse('Unauthorized', { status: 403 });
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

// ─── Password Reset (super_admin only) ───

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
    actorId: session.userId ?? session.id ?? '',
    action: 'password.reset',
    targetType: 'user',
    targetId: userId,
    severity: 'info',
    metadata: { from: 'admin_panel', resetBy: 'super_admin' },
  });

  return NextResponse.json({ message: 'Password reset successfully' });
}
