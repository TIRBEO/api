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
        preferences: true,
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
    signupConsent: (u.preferences as Record<string, any> | null | undefined)?.signupConsent ?? null,
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

  const { reason } = (await request.json().catch(() => ({}))) as any;

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





export async function updateUserRoles(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const body: any = await request.json();
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
      notes: { orderBy: { createdAt: 'desc' }, include: { author: { select: { id: true, email: true, name: true } } } },
    },
  });

  if (!response) return new NextResponse('Response not found', { status: 404 });
  return NextResponse.json(response);
}

// ─── Admin form management (publish/unpublish/archive/delete) ─────
// These send the owner the same per-form-themed lifecycle emails as the
// regular forms flow (publish/archive/delete use each form's theme colors).

const ADMIN_FORM_STATUSES = new Set(['draft', 'published', 'archived', 'closed']);

/** PATCH /api/admin/forms/[id] — change form status (publish/unpublish/archive/close). */
export async function updateAdminForm(request: NextRequest, formId: string) {
  const admin = await requireRole(request, 'manager');
  if (admin instanceof NextResponse) return admin;

  const body: any = await request.json().catch(() => ({}));
  const status = body?.status;
  if (!status || !ADMIN_FORM_STATUSES.has(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

  const updated = await prisma.form.update({
    where: { id: formId },
    data: { status, ...(status === 'published' ? { publishedAt: new Date() } : {}) },
  });

  // Notify the owner with the form's own theme colors.
  const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
  if (owner?.email) {
    const { sendFormLifecycleEmail } = await import('./formHandlers');
    const cfg = {
      draft: { badge: 'Unpublished', title: 'Your form was unpublished', subtitle: 'Your form is no longer accepting responses', body: `Your form was set to draft by an administrator. It will not be visible to respondents until it is published again.`, cta: { url: `${process.env.FORMS_URL || 'https://forms.tirbeo.app'}/builder/${form.id}`, label: 'Open in editor' }, subject: `Your form "${form.title || 'Untitled Form'}" was unpublished`, template: 'form_closed' },
      published: { badge: 'Published', title: 'Your form is now live', subtitle: 'Your form is now accepting responses', body: `Your form has been published. Anyone with the link can now view and fill it out.`, cta: { url: `${process.env.FORMS_URL || 'https://forms.tirbeo.app'}/f/${form.publicId}`, label: 'View form' }, subject: `Your form "${form.title || 'Untitled Form'}" is now live`, template: 'form_published' },
      archived: { badge: 'Archived', title: 'Your form has been archived', subtitle: 'Your form is no longer visible to respondents', body: `Your form was archived by an administrator. Archived forms can be restored anytime.`, cta: { url: `${process.env.FORMS_URL || 'https://forms.tirbeo.app'}/builder/${form.id}`, label: 'Open in editor' }, subject: `Your form "${form.title || 'Untitled Form'}" has been archived`, template: 'form_archived' },
      closed: { badge: 'Closed', title: 'Your form has been closed', subtitle: 'Your form is no longer accepting responses', body: `Your form was closed by an administrator. It is no longer accepting responses.`, cta: { url: `${process.env.FORMS_URL || 'https://forms.tirbeo.app'}/builder/${form.id}`, label: 'Open in editor' }, subject: `Your form "${form.title || 'Untitled Form'}" has been closed`, template: 'form_closed' },
    } as const;
    const c = cfg[status as keyof typeof cfg];
    if (c && status !== 'draft') {
      await sendFormLifecycleEmail(owner.email, form, {
        badge: c.badge,
        title: c.title,
        subtitle: c.subtitle,
        body: c.body,
        details: [{ label: 'Updated', value: new Date().toLocaleString() }],
        cta: c.cta,
        subject: c.subject,
      }, c.template);
    }
  }

  await createAuditEvent({
    actorId: admin.userId,
    action: 'form.updated',
    targetType: 'form',
    targetId: formId,
    metadata: { status, by: 'admin' },
  });

  return NextResponse.json(updated);
}

/** DELETE /api/admin/forms/[id] — permanently remove a form (+ themed deleted email to owner). */
export async function deleteAdminForm(request: NextRequest, formId: string) {
  const admin = await requireRole(request, 'manager');
  if (admin instanceof NextResponse) return admin;

  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

  // Cascade responses/fields are handled by DB relations; delete the form last.
  await prisma.response.deleteMany({ where: { formId } });
  await prisma.form.delete({ where: { id: formId } });

  const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
  if (owner?.email) {
    const { sendFormLifecycleEmail } = await import('./formHandlers');
    await sendFormLifecycleEmail(owner.email, form, {
      badge: 'Form deleted',
      title: 'Your form was deleted',
      subtitle: 'A form was permanently removed from your account',
      body: `Your form was deleted by an administrator. This action cannot be undone. If you believe this was a mistake, please contact support.`,
      details: [{ label: 'Deleted', value: new Date().toLocaleString() }],
      cta: { url: `${process.env.FORMS_URL || 'https://forms.tirbeo.app'}/new`, label: 'Create a new form' },
      subject: `Your form "${form.title || 'Untitled Form'}" was deleted`,
    }, 'form_deleted');
  }

  await createAuditEvent({
    actorId: admin.userId,
    action: 'form.deleted',
    targetType: 'form',
    targetId: formId,
    metadata: { by: 'admin' },
  });

  return NextResponse.json({ success: true });
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
