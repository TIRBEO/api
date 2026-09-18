import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/infrastructure/db/prisma';
import { requireAdmin, requireRole, canManageRole, getAdminRole } from '@/features/auth/http-guards';
import { hashPassword } from '@/features/auth/password';
import { cachedJson, jsonUnauthorized, jsonForbidden } from '@/shared/response';
import { createAuditEvent } from '@/features/security/audit';
import { logSecurityEvent } from '@/features/security/security';
import { generateEventId, refCodeCandidates } from '@/features/users/refcode';

/** Summarize a user's digest/summary email opt-ins from their notification_preferences jsonb. */
function emailOptIns(notificationPreferences: unknown) {
  const p = (notificationPreferences && typeof notificationPreferences === 'object' && !Array.isArray(notificationPreferences)
    ? notificationPreferences : {}) as Record<string, unknown>;
  const on = (v: unknown) => v === true;
  const freq = (v: unknown, fallback: 'daily' | 'weekly') =>
    v === 'daily' || v === 'weekly' || v === 'monthly' ? v : fallback;
  return {
    emailEnabled: p.email !== false,
    digestEnabled: on(p.digestEnabled),
    digestFrequency: freq(p.digestFrequency, 'daily'),
    weeklySummary: on(p.weeklySummary),
    weeklySummaryFrequency: freq(p.weeklySummaryFrequency, 'weekly'),
    lastDigestSentAt: typeof p.lastDigestSentAt === 'string' ? p.lastDigestSentAt : null,
    lastWeeklySentAt: typeof p.lastWeeklySentAt === 'string' ? p.lastWeeklySentAt : null,
  };
}

export async function listUsers(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const search = request.nextUrl.searchParams.get('search') || '';
  const page = Number(request.nextUrl.searchParams.get('page')) || 1;
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 100, 500);

  const { baseWhere, findWhere, digestCond, summaryCond } = buildUserFilters(request, session);

  // Global opt-in counts (scoped to search/role but ignoring the optIn filter)
  // for the admin KPI cards. none = totalBase - any.
  const [users, total, digestCount, summaryCount, anyCount, totalBase] = await Promise.all([
    prisma.user.findMany({
      where: findWhere,
      select: {
        id: true,
        email: true,
        name: true,
        photoUrl: true,
        adminRole: true,
        isBanned: true,
        isSuspended: true,
        banRefCode: true,
        suspendRefCode: true,
        createdAt: true,
        lastActiveAt: true,
        lastLoginAt: true,
        consents: true,
        notificationPreferences: true,
      },
      orderBy: { lastActiveAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count({ where: findWhere }),
    prisma.user.count({ where: { ...baseWhere, AND: [digestCond] } }),
    prisma.user.count({ where: { ...baseWhere, AND: [summaryCond] } }),
    prisma.user.count({ where: { ...baseWhere, AND: [{ OR: [digestCond, summaryCond] }] } }),
    prisma.user.count({ where: baseWhere }),
  ]);

  const mapped = users.map(u => ({
    ...u,
    status: u.isBanned ? 'BANNED' : u.isSuspended ? 'SUSPENDED' : 'ACTIVE',
    eventId: u.isBanned ? u.banRefCode : u.isSuspended ? u.suspendRefCode : null,
    roles: [] as string[],
    signupConsent: (u.consents as Record<string, any> | null | undefined)?.signupConsent ?? null,
    emailOptIns: emailOptIns(u.notificationPreferences),
    lastActiveAt: u.lastActiveAt?.toISOString() || null,
    lastLoginAt: u.lastLoginAt?.toISOString() || null,
  }));

  return NextResponse.json({
    users: mapped,
    total,
    page,
    limit,
    optInCounts: {
      digest: digestCount,
      summary: summaryCount,
      any: anyCount,
      none: Math.max(0, totalBase - anyCount),
    },
  });
}

/** Shared where-clause builder for the users list + CSV export. */
function buildUserFilters(request: NextRequest, session: { adminRole?: string | null }) {
  const search = request.nextUrl.searchParams.get('search') || '';
  const baseWhere: any = search
    ? { OR: [{ email: { contains: search } }, { name: { contains: search } }, { banRefCode: { contains: search } }, { suspendRefCode: { contains: search } }] }
    : {};

  if (session.adminRole !== 'super_admin') {
    baseWhere.adminRole = { not: 'super_admin' };
  }

  // Opt-in filter (digest / activity summary) — matched against the jsonb prefs.
  const digestCond = { notificationPreferences: { path: ['digestEnabled'], equals: true } };
  const summaryCond = { notificationPreferences: { path: ['weeklySummary'], equals: true } };
  const optIn = request.nextUrl.searchParams.get('optIn') || '';
  const optInCondition =
    optIn === 'digest' ? digestCond :
    optIn === 'summary' ? summaryCond :
    optIn === 'any' ? { OR: [digestCond, summaryCond] } :
    optIn === 'none' ? { NOT: { OR: [digestCond, summaryCond] } } : null;
  const findWhere = optInCondition ? { ...baseWhere, AND: [optInCondition] } : baseWhere;

  return { baseWhere, findWhere, optInCondition, digestCond, summaryCond };
}

/**
 * GET /api/admin/users/export?optIn=…&search=… — CSV report of user opt-ins.
 * Exports ALL matching users (no pagination). Row order: last active desc.
 */
export async function exportUsersCsv(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const { findWhere } = buildUserFilters(request, session);
  const users = await prisma.user.findMany({
    where: findWhere,
    select: {
      id: true,
      email: true,
      name: true,
      adminRole: true,
      isBanned: true,
      isSuspended: true,
      createdAt: true,
      lastActiveAt: true,
      notificationPreferences: true,
    },
    orderBy: { lastActiveAt: 'desc' },
  });

  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const date = (d: Date | null | undefined) => (d ? d.toISOString() : '');

  const rows = [
    [
      'user_id', 'email', 'name', 'role', 'status',
      'email_enabled', 'digest_enabled', 'digest_frequency',
      'summary_enabled', 'summary_frequency',
      'last_digest_sent_at', 'last_summary_sent_at',
      'created_at', 'last_active_at',
    ].join(','),
  ];
  for (const u of users) {
    const o = emailOptIns(u.notificationPreferences);
    rows.push([
      u.id,
      esc(u.email),
      esc(u.name || ''),
      u.adminRole || '',
      u.isBanned ? 'BANNED' : u.isSuspended ? 'SUSPENDED' : 'ACTIVE',
      o.emailEnabled ? 'yes' : 'no',
      o.digestEnabled ? 'yes' : 'no',
      o.digestEnabled ? o.digestFrequency : '',
      o.weeklySummary ? 'yes' : 'no',
      o.weeklySummary ? o.weeklySummaryFrequency : '',
      o.lastDigestSentAt || '',
      o.lastWeeklySentAt || '',
      date(u.createdAt),
      date(u.lastActiveAt),
    ].join(','));
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const optIn = request.nextUrl.searchParams.get('optIn') || 'all';
  return new NextResponse(rows.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="tirbeo-optins-${optIn}-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
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
      banRefCode: true,
      suspendRefCode: true,
      createdAt: true,
      updatedAt: true,
      consents: true,
      notificationPreferences: true,
      _count: { select: { sessions: true, notifications: true } },
      sessions: {
        select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
    },
  });
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  return NextResponse.json({
    ...user,
    status: user.isBanned ? 'BANNED' : user.isSuspended ? 'SUSPENDED' : 'ACTIVE',
    eventId: user.isBanned ? user.banRefCode : user.isSuspended ? user.suspendRefCode : null,
    roles: [],
    signupConsent: (user.consents as Record<string, any> | null | undefined)?.signupConsent ?? null,
    emailOptIns: emailOptIns(user.notificationPreferences),
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
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  const { email, name, adminRole, sendEmail = true } = parsed.data;
  const normalizedEmail = email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });

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
    const { sendTemplateEmail } = await import('@/features/email/email');
    const res = await sendTemplateEmail(normalizedEmail, 'welcome', {
      name: name || normalizedEmail.split('@')[0],
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
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const body: any = await request.json();
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  if (parsed.data.adminRole !== undefined) {
    if (!canManageRole(session.adminRole, existing.adminRole)) {
      return NextResponse.json({ error: 'Cannot change role of this user' }, { status: 403 });
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
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  await prisma.user.delete({ where: { id: userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.deleted',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email, displayName: existing.name },
  });

  return NextResponse.json({ error: 'User deleted' }, { status: 200 });
}



export async function banUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  if (existing.adminRole === 'super_admin') return NextResponse.json({ error: 'Cannot ban a super admin' }, { status: 403 });

  const { reason } = (await request.json().catch(() => ({}))) as any;

  await prisma.user.update({ where: { id: userId }, data: { isBanned: true, isSuspended: false, suspendReason: reason || 'No reason provided', suspendedUntil: null, banRefCode: existing.banRefCode || generateEventId('ban') } });
  await prisma.session.deleteMany({ where: { userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.banned',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email, reason: reason || 'No reason provided' },
  });
  logSecurityEvent({ request, userId, eventType: 'security.account_banned', severity: 'critical', details: { reason: reason || 'No reason provided', byAdmin: session.userId }, notifyAdmin: true }).catch(() => {});

  const { sendTemplateEmail } = await import('@/features/email/email');
  sendTemplateEmail(existing.email, 'account_suspended', {
    name: existing.name || existing.email,
    statusType: 'permanently banned',
    reason: reason || 'No reason provided',
    untilLabel: '',
    actionLabel: 'Contact support at support@tirbeo.app if you believe this is a mistake.',
    dashboardUrl: (await import('@/config/app-urls')).getDashboardBaseUrl(),
  }, { rawVars: [] }).catch(() => {});

  return NextResponse.json({ message: 'User banned' });
}

export async function unbanUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  await prisma.user.update({ where: { id: userId }, data: { isBanned: false, isSuspended: false, suspendedUntil: null, suspendReason: null } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.unbanned',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email },
  });
  logSecurityEvent({ request, userId, eventType: 'security.account_unbanned', details: { byAdmin: session.userId } }).catch(() => {});

  return NextResponse.json({ message: 'User unbanned' });
}

export async function suspendUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  if (existing.adminRole === 'super_admin') return NextResponse.json({ error: 'Cannot suspend a super admin' }, { status: 403 });

  const body: any = await request.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'No reason provided';
  const days = Number.isFinite(body.days) ? Math.max(1, Math.min(365, Number(body.days))) : null;
  const until = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;

  await prisma.user.update({ where: { id: userId }, data: { isSuspended: true, isBanned: false, suspendReason: reason, suspendedUntil: until, suspendRefCode: existing.suspendRefCode || generateEventId('suspend') } });
  await prisma.session.deleteMany({ where: { userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.suspended',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email, reason, days },
  });
  logSecurityEvent({ request, userId, eventType: 'security.account_suspended', severity: 'warning', details: { reason, days, until: until?.toISOString() || null, byAdmin: session.userId }, notifyAdmin: true }).catch(() => {});

  const { sendTemplateEmail } = await import('@/features/email/email');
  sendTemplateEmail(existing.email, 'account_suspended', {
    name: existing.name || existing.email,
    statusType: days ? `suspended for ${days} day${days > 1 ? 's' : ''}` : 'suspended indefinitely',
    reason,
    untilLabel: until ? ` Your account will be restored automatically on ${until.toUTCString()}.` : ' Contact support to restore access.',
    actionLabel: 'During suspension you cannot sign in or use Tirbeo services.',
    dashboardUrl: (await import('@/config/app-urls')).getDashboardBaseUrl(),
  }).catch(() => {});

  return NextResponse.json({ message: 'User suspended', until: until?.toISOString() || null });
}

export async function unsuspendUser(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'super_admin');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  await prisma.user.update({ where: { id: userId }, data: { isSuspended: false, suspendedUntil: null, suspendReason: null } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.unsuspended',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email },
  });
  logSecurityEvent({ request, userId, eventType: 'security.account_unsuspended', details: { byAdmin: session.userId } }).catch(() => {});

  return NextResponse.json({ message: 'User unsuspended' });
}

export async function resolveUserByRefCode(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const code = (request.nextUrl.searchParams.get('code') || '').trim();
  const candidates = refCodeCandidates(code);
  if (!candidates.length) {
    return NextResponse.json({ error: 'Invalid reference code. Expected a format like 4155-7b96-49e0 or 524c-9f2d-4e1a.' }, { status: 400 });
  }

  // Typed codes (4155/524c/5359-…) carry the family in the first block, but
  // ban and suspension share "AU" (4155), and legacy stored values may still
  // be SUS-/BAN- prefixed — so both ref-code columns are always searched.
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { banRefCode: { in: candidates, mode: 'insensitive' } },
        { suspendRefCode: { in: candidates, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true, email: true, name: true, photoUrl: true, adminRole: true,
      isBanned: true, isSuspended: true, suspendReason: true, suspendedUntil: true,
      banRefCode: true, suspendRefCode: true, lastActiveAt: true,
    },
  });
  if (!user) {
    return NextResponse.json({ error: 'No user found for that reference code' }, { status: 404 });
  }

  return NextResponse.json({
    user: {
      ...user,
      status: user.isBanned ? 'BANNED' : user.isSuspended ? 'SUSPENDED' : 'ACTIVE',
      eventId: user.isBanned ? user.banRefCode : user.isSuspended ? user.suspendRefCode : null,
      lastActiveAt: user.lastActiveAt?.toISOString() || null,
    },
  });
}





export async function seedAdminHandler(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body: any = await request.json();
  const { email, adminRole, password } = body;

  if (!email || !adminRole) {
    return NextResponse.json({ error: 'email and adminRole required' }, { status: 400 });
  }

  if (!process.env.ADMIN_SEED_EMAIL) {
    return NextResponse.json({ error: 'Seed endpoint is disabled. Set ADMIN_SEED_EMAIL env var.' }, { status: 403 });
  }
  if (email !== process.env.ADMIN_SEED_EMAIL) {
    return jsonForbidden();
  }

  const { hashPassword: hashPw } = await import('@/features/auth/password');
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
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const { hashPassword } = await import('@/features/auth/password');
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

  // Notify the user that their password was reset by an admin
  const { createNotification } = await import('@/features/notifications/notifications');
  createNotification({
    userId,
    type: 'security',
    title: 'Password reset by administrator',
    body: 'Your password was reset by an administrator. If you did not request this, contact support immediately.',
    link: '/account/security',
  }).catch(() => {});

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

export async function adminMaintenanceHandler(request: NextRequest) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const { getMaintenanceState, setMaintenanceMode } = await import('@/infrastructure/realtime/ws/server');

  if (request.method === 'GET') {
    // Also process expired scheduled deletions on maintenance check
    const { processScheduledDeletions } = await import('@/features/users/userHandlers');
    const deletionResult = await processScheduledDeletions().catch(() => ({ deleted: 0 }));
    return NextResponse.json({ ...getMaintenanceState(), deletedUsers: deletionResult.deleted });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { enabled, message, estimatedEnd, allowedUsers, scheduledStart, scheduledEnd } = body as {
      enabled?: boolean; message?: string; estimatedEnd?: number | null;
      allowedUsers?: string[]; scheduledStart?: number | null; scheduledEnd?: number | null;
    };
    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled (boolean) is required' }, { status: 400 });
    }
    setMaintenanceMode(enabled, message, estimatedEnd ?? undefined, allowedUsers, scheduledStart, scheduledEnd);
    createAuditEvent({
      action: enabled ? 'maintenance.enabled' : 'maintenance.disabled',
      actorId: session.userId,
      targetType: 'maintenance',
      targetId: 'system',
      metadata: { message: message || undefined },
    }).catch(() => {});
    return NextResponse.json({ ok: true, ...getMaintenanceState() });
  } catch (err: any) {
    console.error('[ADMIN MAINTENANCE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to update maintenance mode' }, { status: 500 });
  }
}
