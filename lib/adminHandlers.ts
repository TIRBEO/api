import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from './db/prisma';
import { requireAdmin, requireRole, canManageRole, getAdminRole } from './session';
import { hashPassword } from './auth/password';
import { cachedJson, jsonUnauthorized, jsonForbidden } from './response';
import { createAuditEvent } from './audit';

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
        lastActiveAt: true,
        lastLoginAt: true,
        consents: true,
        roles: {
          select: { role: { select: { id: true, name: true } } },
        },
      },
      orderBy: { lastActiveAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  const mapped = users.map(u => ({
    ...u,
    status: u.isBanned ? 'BANNED' : u.isSuspended ? 'SUSPENDED' : 'ACTIVE',
    roles: u.roles.map(a => a.role),
    signupConsent: (u.consents as Record<string, any> | null | undefined)?.signupConsent ?? null,
    lastActiveAt: u.lastActiveAt?.toISOString() || null,
    lastLoginAt: u.lastLoginAt?.toISOString() || null,
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
      consents: true,
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
    signupConsent: (user.consents as Record<string, any> | null | undefined)?.signupConsent ?? null,
    roleAssignments: undefined,
  });
}

const updateUserSchema = z.object({
  displayName: z.string().min(1).optional(),
  adminRole: z.enum(['super_admin', 'admin', 'manager', 'editor']).nullable().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']).optional(),
});

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120).optional(),
  adminRole: z.enum(['super_admin', 'admin', 'manager', 'editor']).nullable().optional(),
  sendEmail: z.boolean().optional(),
});

function generateTemporaryPassword(length = 16): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
  const arr = new Uint32Array(length);
  const rnd = typeof crypto !== 'undefined' && 'getRandomValues' in crypto
    ? crypto.getRandomValues(arr)
    : Array.from({ length }, () => Math.floor(Math.random() * 0xffffffff));
  return Array.from({ length }, (_, i) => alphabet[Number(rnd[i]) % alphabet.length]).join('');
}

export async function createUser(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body: any = await request.json();
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) return new NextResponse('Invalid payload', { status: 400 });

  const { email, name, adminRole, sendEmail = true } = parsed.data;
  const normalizedEmail = email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) return new NextResponse('A user with this email already exists', { status: 409 });

  if (adminRole === 'super_admin' && session.adminRole !== 'super_admin') {
    return jsonForbidden();
  }
  if (adminRole && !canManageRole(session.adminRole, adminRole)) {
    return jsonForbidden();
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name: name || null,
      adminRole: adminRole || null,
      passwordHash,
      emailVerified: true,
      mustChangePassword: true,
    },
    select: { id: true, email: true, name: true, adminRole: true, createdAt: true },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.created',
    targetType: 'user',
    targetId: user.id,
    metadata: { email: normalizedEmail, adminRole: adminRole || null, temporaryPasswordIssued: true },
  });

  if (sendEmail) {
    const { sendTemplateEmail } = await import('./email');
    const res = await sendTemplateEmail(normalizedEmail, 'admin_account_created', {
      name: name || normalizedEmail.split('@')[0],
      temporaryPassword,
      adminRole: adminRole || 'member',
      loginUrl: 'https://admin.tirbeo.app',
    });
    if (!res.success) {
      console.error(`[ADMIN CREATE USER] Email failed for ${normalizedEmail}: ${res.error}`);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[ADMIN CREATE USER] FALLBACK TEMP PASSWORD for ${normalizedEmail}: ${temporaryPassword}`);
      }
    }
  }

  // Only echo the temporary password in non-production (email may not be configured).
  const echoPassword = sendEmail && process.env.NODE_ENV !== 'production';
  return NextResponse.json({
    user: { ...user, mustChangePassword: true },
    ...(echoPassword ? { temporaryPassword } : {}),
    emailSent: sendEmail,
    note: 'The user must set a new password on first login.',
  }, { status: 201 });
}

export async function updateUser(request: NextRequest, userId: string) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });

  const body: any = await request.json();
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



export async function banUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return new NextResponse('User not found', { status: 404 });
  if (existing.adminRole === 'super_admin') return new NextResponse('Cannot ban a super admin', { status: 403 });

  const { reason } = (await request.json().catch(() => ({}))) as any;

  await prisma.user.update({ where: { id: userId }, data: { isBanned: true, isSuspended: false, suspendReason: reason || 'No reason provided', suspendedUntil: null } });
  await prisma.session.deleteMany({ where: { userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.banned',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email, reason: reason || 'No reason provided' },
  });

  const { sendTemplateEmail } = await import('./email');
  sendTemplateEmail(existing.email, 'account_suspended', {
    name: existing.name || existing.email,
    statusType: 'permanently banned',
    reason: reason || 'No reason provided',
    untilLabel: '',
    actionLabel: 'Contact support at support@tirbeo.app if you believe this is a mistake.',
    dashboardUrl: (await import('./app-urls')).getDashboardBaseUrl(),
  }, { rawVars: [] }).catch(() => {});

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

  const body: any = await request.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'No reason provided';
  const days = Number.isFinite(body.days) ? Math.max(1, Math.min(365, Number(body.days))) : null;
  const until = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;

  await prisma.user.update({ where: { id: userId }, data: { isSuspended: true, isBanned: false, suspendReason: reason, suspendedUntil: until } });
  await prisma.session.deleteMany({ where: { userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.suspended',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email, reason, days },
  });

  const { sendTemplateEmail } = await import('./email');
  sendTemplateEmail(existing.email, 'account_suspended', {
    name: existing.name || existing.email,
    statusType: days ? `suspended for ${days} day${days > 1 ? 's' : ''}` : 'suspended indefinitely',
    reason,
    untilLabel: until ? ` Your account will be restored automatically on ${until.toUTCString()}.` : ' Contact support to restore access.',
    actionLabel: 'During suspension you cannot sign in or use Tirbeo services.',
    dashboardUrl: (await import('./app-urls')).getDashboardBaseUrl(),
  }).catch(() => {});

  return NextResponse.json({ message: 'User suspended', until: until?.toISOString() || null });
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





export async function seedAdminHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body: any = await request.json();
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

  const body: any = await request.json();
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



export async function getStats(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const [userCount, auditCount, blocklistCount] = await Promise.all([
    prisma.user.count(),
    prisma.auditEvent.count(),
    prisma.blocklist.count(),
  ]);

  const adminUsers = await prisma.user.findMany({
    where: { adminRole: { not: null } },
    select: { id: true, email: true, name: true, adminRole: true },
  });

  return cachedJson({
    counts: { users: userCount, auditEvents: auditCount, blocked: blocklistCount },
    adminUsers,
  }, { ttl: 15, swr: 120 });
}
