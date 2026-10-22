import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/infrastructure/db/prisma';
import { requireAdmin, requireRole, canManageRole } from '@/features/auth/http-guards';
import { hashPassword } from '@/features/auth/password';
import { cachedJson, jsonForbidden } from '@/shared/response';
import { createAuditEvent } from '@/features/security/audit';
import { logSecurityEvent } from '@/features/security/security';
import { generateEventId, refCodeCandidates, ensureRefCode } from '@/features/users/refcode';
import { isValidTirbeoUsername, tirbeoEmailFor, upsertMailAccount, recordProvisioning } from '@/features/identity/tirbeo';
import { createSupabaseAuthUser } from '@/features/auth/supabase-admin';
import { getAccountsBaseUrl } from '@/config/app-urls';
import { forgetUserStatus } from '@/features/auth/user-status-cache';

/**
 * Summarize a user's email opt-ins from their notification_preferences jsonb.
 *
 * There used to be two recurring mails — a per-event digest and a weekly
 * summary. There is one now: the account recap, on whichever cadence the person
 * picked. The digest fields are gone rather than kept as aliases, so an admin
 * reading this row cannot be shown a decision nobody can still make.
 */
function emailOptIns(notificationPreferences: unknown) {
  const p = (notificationPreferences && typeof notificationPreferences === 'object' && !Array.isArray(notificationPreferences)
    ? notificationPreferences : {}) as Record<string, unknown>;
  const on = (v: unknown) => v === true;
  const freq = (v: unknown, fallback: 'daily' | 'weekly' | 'monthly') =>
    v === 'daily' || v === 'weekly' || v === 'monthly' ? v : fallback;
  return {
    emailEnabled: p.email !== false,
    // A pause in the past is no pause; isEmailPaused says the same on the send path.
    paused: on(p.emailPaused) && (typeof p.emailPausedUntil !== 'number' || p.emailPausedUntil > Date.now()),
    summaryEnabled: on(p.summaryEnabled),
    summaryFrequency: freq(p.summaryFrequency, 'weekly'),
    lastSummarySentAt: typeof p.lastSummarySentAt === 'string' ? p.lastSummarySentAt : null };
}

/** Public status label derived from the consolidated users.status enum. */
function statusLabel(status: string): string {
  switch (status) {
    case 'banned': return 'BANNED';
    case 'suspended': return 'SUSPENDED';
    case 'deleted': return 'DELETED';
    case 'deletion_pending': return 'PENDING_DELETION';
    default: return 'ACTIVE';
  }
}

const ENFORCE_STATUSES = ['banned', 'suspended'] as const;

/** Every value of the users.status enum, in the schema's own words. A filter
    list built from here cannot drift from a migration that adds a state. */
const USER_STATUSES = [
  'active',
  'restricted',
  'banned',
  'suspended',
  'deactivated',
  'deletion_pending',
  'deleted',
] as const;

/** `statusLabel` is a display string and deliberately lossy — restricted and
    deactivated both read as ACTIVE — so the raw enum travels beside it rather
    than replacing it. A screen that filters by `deactivated` must be able to
    show the row it found as deactivated. */
function isUserStatus(v: string | null): v is (typeof USER_STATUSES)[number] {
  return v !== null && (USER_STATUSES as readonly string[]).includes(v);
}

/** Order the list by what the caller asked for. Names live on the profile
    row, which is one-to-one and may be absent, so those rows sort last. */
function userOrderBy(sort: string | null): Prisma.UserOrderByWithRelationInput {
  switch (sort) {
    case 'oldest':
      return { createdAt: 'asc' };
    case 'newest':
      return { createdAt: 'desc' };
    case 'name':
      return { profile: { name: { sort: 'asc', nulls: 'last' } } };
    default:
      return { lastActiveAt: { sort: 'desc', nulls: 'last' } };
  }
}

/**
 * Batch-load the enforcement rows backing the legacy ban/suspend columns:
 * the latest banned/suspended status events (metadata.refCode) and the latest
 * restrictions (detail/endsAt) for a set of users.
 */
async function loadEnforcement(userIds: string[]) {
  if (!userIds.length) return { events: [] as Awaited<ReturnType<typeof prisma.userStatusEvent.findMany>>[], restrictions: [] as Awaited<ReturnType<typeof prisma.userRestriction.findMany>>[] };
  const [events, restrictions] = await Promise.all([
    prisma.userStatusEvent.findMany({
      where: { userId: { in: userIds }, toStatus: { in: [...ENFORCE_STATUSES] } },
      orderBy: { createdAt: 'desc' } }),
    prisma.userRestriction.findMany({
      where: { userId: { in: userIds } },
      orderBy: { startedAt: 'desc' } }),
  ]);
  return { events, restrictions };
}

/**
 * Flatten a user row (profile/preferences/status) plus its enforcement rows
 * into the shape the admin console has always consumed — keeping the legacy
 * field names (name, photoUrl, adminRole, isBanned, isSuspended, banRefCode,
 * suspendRefCode, consents, notificationPreferences) sourced from the new
 * single-concern tables.
 *
 * ASYNC on purpose: when a blocked user's reference code is not yet persisted
 * in user_status_events.metadata.refCode (legacy enforcements predating the
 * code column), shapeUserRow asks ensureRefCode to MINT + PERSIST one rather
 * than hand back a synthetic deterministic value — every code an admin or a
 * user ever sees must be findable in the database.
 */
async function shapeUserRow(
  u: any,
  events: any[],
  restrictions: any[],
): Promise<any> {
  const kind = u.status === 'banned' ? 'ban' : u.status === 'suspended' ? 'suspend' : null;
  const ev = kind ? events.find((e) => e.userId === u.id && e.toStatus === u.status) : null;
  const eventId = kind ? ((ev?.metadata as any)?.refCode || await ensureRefCode(u.id, kind)) : null;
  const rest = restrictions.find((r) => r.userId === u.id) || null;
  const consents = (u.preferences?.misc as any)?.consents ?? null;
  const notif = (u.preferences?.notif as any) ?? {};
  return {
    id: u.id,
    email: u.email,
    username: u.username ?? null,
    name: u.profile?.name ?? null,
    photoUrl: u.profile?.photoUrl ?? null,
    adminRole: u.isAdmin ? 'admin' : null,
    isBanned: u.status === 'banned',
    isSuspended: u.status === 'suspended',
    status: statusLabel(u.status),
    statusKind: u.status,
    eventId,
    banRefCode: u.status === 'banned' ? eventId : null,
    suspendRefCode: u.status === 'suspended' ? eventId : null,
    suspendReason: u.status === 'suspended' ? (rest?.detail ?? ev?.reason ?? null) : null,
    suspendedUntil: u.status === 'suspended' ? (rest?.endsAt ?? (ev?.metadata as any)?.until ?? null) : null,
    reason: kind ? (rest?.detail ?? ev?.reason ?? null) : null,
    until: kind ? (rest?.endsAt ?? (ev?.metadata as any)?.until ?? null) : null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastActiveAt: u.lastActiveAt,
    lastLoginAt: u.lastLoginAt,
    consents,
    notificationPreferences: notif,
    roles: [] as string[],
    signupConsent: (consents as Record<string, any> | null)?.signupConsent ?? null,
    emailOptIns: emailOptIns(notif),
  };
}

/** Base select covering every field shapeUserRow needs from the User table. */
const ADMIN_USER_SELECT = {
  id: true,
  email: true,
  username: true,
  status: true,
  isAdmin: true,
  createdAt: true,
  updatedAt: true,
  lastActiveAt: true,
  lastLoginAt: true,
  profile: { select: { name: true, photoUrl: true } },
  preferences: { select: { notif: true, misc: true } },
} as const;

export async function listUsers(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;


  const page = Number(request.nextUrl.searchParams.get('page')) || 1;
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 100, 500);
  const orderBy = userOrderBy(request.nextUrl.searchParams.get('sort'));

  const { baseWhere, findWhere, recapCond, pausedCond } = buildUserFilters(request, session);

  // Global opt-in counts (scoped to search/role but ignoring the optIn filter)
  // for the admin KPI cards.
  const [usersRaw, total, recapCount, pausedCount, anyCount, totalBase] = await Promise.all([
    prisma.user.findMany({
      where: findWhere,
      select: ADMIN_USER_SELECT,
      orderBy,
      skip: (page - 1) * limit,
      take: limit }),
    prisma.user.count({ where: findWhere }),
    prisma.user.count({ where: { ...baseWhere, AND: [recapCond] } }),
    prisma.user.count({ where: { ...baseWhere, AND: [pausedCond] } }),
    prisma.user.count({ where: { ...baseWhere, AND: [{ OR: [recapCond, pausedCond] }] } }),
    prisma.user.count({ where: baseWhere }),
  ]);

  const { events, restrictions } = await loadEnforcement(usersRaw.map(u => u.id));
  const mapped = await Promise.all(usersRaw.map(async u => {
    const s = await shapeUserRow(u, events, restrictions);
    return { ...s, lastActiveAt: u.lastActiveAt?.toISOString() || null, lastLoginAt: u.lastLoginAt?.toISOString() || null };
  }));

  return NextResponse.json({
    users: mapped,
    total,
    page,
    limit,
    optInCounts: {
      recap: recapCount,
      paused: pausedCount,
      any: anyCount,
      none: Math.max(0, totalBase - anyCount) } });
}

/** Shared where-clause builder for the users list + CSV export. */
function buildUserFilters(request: NextRequest, _session: { adminRole?: string | null }) {
  const search = request.nextUrl.searchParams.get('search') || '';
  // Search matches email, handle, profile name, an exact id, or a ban/suspend
  // ref code held in a status event's metadata. An id is a prefix of a uuid, so
  // `contains` rather than `equals` still lands on one row — and an operator
  // pasting eight characters of a link is how this lookup actually gets used.
  const baseWhere: any = search
    ? {
        OR: [
          { email: { contains: search, mode: 'insensitive' } },
          { username: { contains: search, mode: 'insensitive' } },
          { profile: { is: { name: { contains: search, mode: 'insensitive' } } } },
          { id: { contains: search } },
          { statusEvents: { some: { toStatus: { in: [...ENFORCE_STATUSES] }, metadata: { path: ['refCode'], equals: search } } } },
        ] }
    : {};

  // The lifecycle state, in the schema's own words. Anything outside the enum
  // is ignored rather than passed to Prisma, where it would throw a 500 on a
  // typo in a query string.
  const status = request.nextUrl.searchParams.get('status');
  const statusCondition = isUserStatus(status) ? { status } : null;

  // Console access is one boolean today, so the filter is yes or no; anything
  // else means the caller did not ask.
  const admin = request.nextUrl.searchParams.get('admin');
  const adminCondition = admin === 'yes' ? { isAdmin: true } : admin === 'no' ? { isAdmin: false } : null;

  // Opt-in filter — matched against the notification prefs jsonb on user_preferences.
  const recapCond = { preferences: { is: { notif: { path: ['summaryEnabled'], equals: true } } } };
  const pausedCond = { preferences: { is: { notif: { path: ['emailPaused'], equals: true } } } };
  const optIn = request.nextUrl.searchParams.get('optIn') || '';
  const optInCondition =
    optIn === 'recap' || optIn === 'summary' ? recapCond :
    optIn === 'paused' ? pausedCond :
    optIn === 'any' ? { OR: [recapCond, pausedCond] } :
    optIn === 'none' ? { NOT: { OR: [recapCond, pausedCond] } } : null;

  const filters = [statusCondition, adminCondition, optInCondition].filter(Boolean);
  const findWhere = filters.length ? { ...baseWhere, AND: filters } : baseWhere;

  return { baseWhere, findWhere, optInCondition, recapCond, pausedCond };
}

/**
 * GET /api/admin/users/export?optIn=…&search=… — CSV report of user opt-ins.
 * Exports ALL matching users (no pagination). Row order: last active desc.
 */
export async function exportUsersCsv(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const { findWhere } = buildUserFilters(request, session);
  const usersRaw = await prisma.user.findMany({
    where: findWhere,
    select: ADMIN_USER_SELECT,
    orderBy: { lastActiveAt: 'desc' } });

  const { events, restrictions } = await loadEnforcement(usersRaw.map(u => u.id));
  const users = await Promise.all(usersRaw.map(u => shapeUserRow(u, events, restrictions)));

  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const date = (d: Date | null | undefined) => (d ? d.toISOString() : '');

  const rows = [
    [
      'user_id', 'email', 'name', 'role', 'status',
      'email_enabled', 'email_paused', 'recap_enabled', 'recap_frequency',
      'last_recap_sent_at', 'created_at', 'last_active_at',
    ].join(','),
  ];
  for (const u of users) {
    const o = u.emailOptIns;
    rows.push([
      u.id,
      esc(u.email),
      esc(u.name || ''),
      u.adminRole || '',
      u.status,
      o.emailEnabled ? 'yes' : 'no',
      o.paused ? 'yes' : 'no',
      o.summaryEnabled ? 'yes' : 'no',
      o.summaryEnabled ? o.summaryFrequency : '',
      o.lastSummarySentAt || '',
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
      'Cache-Control': 'no-store' } });
}

export async function getUserDetail(request: NextRequest, userId: string) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      username: true,
      status: true,
      isAdmin: true,
      createdAt: true,
      updatedAt: true,
      lastActiveAt: true,
      lastLoginAt: true,
      profile: { select: { name: true, photoUrl: true } },
      preferences: { select: { notif: true, misc: true } },
      security: { select: { totpEnabled: true } },
      emails: { select: { kind: true, verifiedAt: true, isDefault: true } },
      _count: { select: { sessions: true, notifications: true } },
      sessions: {
        select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
        orderBy: { createdAt: 'desc' },
        take: 10 } } });
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const { events, restrictions } = await loadEnforcement([user.id]);
  const shaped = await shapeUserRow(user, events, restrictions);
  const emailVerified = user.emails.some(e => (e.kind === 'primary' || e.isDefault) && !!e.verifiedAt);

  return NextResponse.json({
    id: user.id,
    email: user.email,
    username: user.username,
    name: shaped.name,
    photoUrl: shaped.photoUrl,
    adminRole: shaped.adminRole,
    isBanned: shaped.isBanned,
    isSuspended: shaped.isSuspended,
    is2FAEnabled: user.security?.totpEnabled ?? false,
    emailVerified,
    banRefCode: shaped.banRefCode,
    suspendRefCode: shaped.suspendRefCode,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    consents: shaped.consents,
    notificationPreferences: shaped.notificationPreferences,
    _count: user._count,
    sessions: user.sessions,
    status: shaped.status,
    statusKind: shaped.statusKind,
    eventId: shaped.eventId,
    roles: [],
    signupConsent: shaped.signupConsent,
    emailOptIns: shaped.emailOptIns,
    roleAssignments: undefined });
}

const updateUserSchema = z.object({
  displayName: z.string().min(1).optional(),
  adminRole: z.enum(['super_admin', 'admin', 'manager', 'editor']).nullable().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']).optional() });

const createUserSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).max(120).optional(),
  firstName: z.string().min(1).max(60).optional(),
  lastName: z.string().min(1).max(60).optional(),
  username: z.string().min(1).max(64).optional(),
  recoveryEmail: z.string().email().optional(),
  adminRole: z.enum(['super_admin', 'admin', 'manager', 'editor']).nullable().optional(),
  sendEmail: z.boolean().optional() }).refine((d) => !!d.email || !!d.username, { message: 'An email or Tirbeo username is required' });

function generateTemporaryPassword(length = 16): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*';
  // Rejection sampling over Web Crypto only: `Math.random % alphabet.length`
  // both leaked a non-crypto path and skewed the letter distribution (256 is
  // not a multiple of 59). Every accepted value is uniform.
  const out: string[] = [];
  // The whole value space of a uint32 is 2^32, not 2^32 - 1: the largest
  // value a uint32 can hold is one below it, but the space it can produce has
  // 2^32 members. The cut-off is the largest whole number of alphabets that
  // fits, so the accepted values divide evenly by the alphabet's length and
  // every character is equally likely.
  const range = 0x100000000;
  const limit = range - (range % alphabet.length);
  while (out.length < length) {
    const batch = crypto.getRandomValues(new Uint32Array((length - out.length) * 2));
    for (const v of batch) {
      if (v < limit) out.push(alphabet[v % alphabet.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

export async function createUser(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body: any = await request.json();
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  const { username, recoveryEmail, firstName, lastName, adminRole, sendEmail = true } = parsed.data;
  const name = parsed.data.name || `${firstName || ''} ${lastName || ''}`.trim() || null;

  if (adminRole === 'super_admin' && session.adminRole !== 'super_admin') {
    return jsonForbidden();
  }
  if (adminRole && !canManageRole(session.adminRole, adminRole)) {
    return jsonForbidden();
  }

  // Tirbeo identity flow: username -> username@tirbeo.com is the account's
  // login identity and mail address. An externally supplied email may not
  // become the identity (recovery email never does).
  if (username) {
    const userName = username.toString().trim().toLowerCase();
    if (!isValidTirbeoUsername(userName)) {
      return NextResponse.json({ error: 'Invalid Tirbeo username. Use letters, numbers, dots, dashes or underscores.' }, { status: 400 });
    }
    const tirbeoEmail = tirbeoEmailFor(userName);

    const identityTaken = await prisma.tirbeoIdentity.findUnique({ where: { username: userName }, select: { id: true } });
    if (identityTaken) {
      return NextResponse.json({ error: 'This Tirbeo username is already taken' }, { status: 409 });
    }
    const emailTaken = await prisma.user.findUnique({ where: { email: tirbeoEmail }, select: { id: true } });
    if (emailTaken) {
      return NextResponse.json({ error: 'A user already exists for this Tirbeo email' }, { status: 409 });
    }
    if (parsed.data.email && parsed.data.email.toLowerCase() !== tirbeoEmail) {
      return NextResponse.json({ error: 'Tirbeo accounts use username@tirbeo.com — the email is derived from the username.' }, { status: 400 });
    }
    const recovery = recoveryEmail ? recoveryEmail.toString().trim().toLowerCase() : undefined;

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email: tirbeoEmail,
          username: userName,
          passwordHash,
          isAdmin: adminRole != null },
        select: { id: true, email: true, username: true, isAdmin: true, createdAt: true } });
      await tx.userProfile.create({ data: { userId: u.id, name: name || userName } });
      await tx.userEmail.create({
        data: { userId: u.id, address: tirbeoEmail, kind: 'primary', verifiedAt: new Date(), isDefault: true } });
      await tx.userSecurity.create({ data: { userId: u.id, mustChangePw: true } });
      await tx.tirbeoIdentity.create({
        data: { userId: u.id, username: userName, email: tirbeoEmail, verifiedSource: 'admin', verifiedAt: new Date() } });
      if (recovery) {
        const addr = recovery.trim().toLowerCase();
        await tx.userEmail.upsert({
          where: { userId_address: { userId: u.id, address: addr } },
          create: { userId: u.id, address: addr, kind: 'recovery', verifiedAt: new Date() },
          update: { kind: 'recovery', verifiedAt: new Date() } });
      }
      return { ...u, name: name || userName, adminRole: adminRole || null };
    });

    // Registry: every @tirbeo.com account gets a mail_accounts row (role
    // mirrors adminRole). The D1 mailbox itself is provisioned on first sign-in.
    await upsertMailAccount({
      userId: user.id,
      username: userName,
      role: adminRole ? 'admin' : 'user',
      provisioned: false,
      provisionedBy: 'admin' });
    recordProvisioning({
      userId: user.id,
      target: 'tirbeo_identity',
      status: 'ok',
      method: 'admin',
      detail: `Identity ${tirbeoEmail} created by admin ${session.userId}.` });

    // Provision the same identity in Supabase Auth (best-effort, non-fatal).
    const supabase = await createSupabaseAuthUser({
      email: tirbeoEmail,
      password: temporaryPassword,
      emailConfirm: true,
      userMetadata: { username: userName, full_name: name, tirbeo: true },
      appMetadata: { provider: 'tirbeo' } });
    recordProvisioning({
      userId: user.id,
      target: 'supabase_user',
      status: supabase.ok ? 'ok' : 'failed',
      method: 'admin',
      detail: supabase.ok
        ? `Supabase auth user ${tirbeoEmail} created by admin.`
        : `Supabase provisioning skipped: ${supabase.reason || 'unknown'}` });
    if (!supabase.ok) {
      console.error(`[ADMIN CREATE TIRBEO] Supabase provisioning skipped for ${tirbeoEmail}: ${supabase.reason || 'unknown'}`);
    }

    await createAuditEvent({
      actorId: session.userId,
      action: 'user.created',
      targetType: 'user',
      targetId: user.id,
      metadata: {
        email: tirbeoEmail,
        username: userName,
        recoveryEmail: recovery || null,
        adminRole: adminRole || null,
        temporaryPasswordIssued: true,
        supabaseProvisioned: supabase.ok } });

    let emailSent = false;
    if (sendEmail && recovery) {
      const { sendTemplateEmail } = await import('@/features/email/email');
      const res = await sendTemplateEmail(recovery, 'tirbeo_account_onboarding', {
        name: name || userName,
        username: userName,
        password: temporaryPassword,
        accountsUrl: getAccountsBaseUrl(),
        recoveryEmail: recovery });
      emailSent = res.success;
      if (!res.success) {
        console.error(`[ADMIN CREATE TIRBEO] Onboarding email failed for ${recovery}`);
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[ADMIN CREATE TIRBEO] FALLBACK TEMP PASSWORD for ${tirbeoEmail}: ${temporaryPassword}`);
        }
      }
    } else if (sendEmail) {
      const { sendTemplateEmail } = await import('@/features/email/email');
      const res = await sendTemplateEmail(tirbeoEmail, 'welcome', { name: name || userName });
      emailSent = res.success;
    }

    // Only echo the temporary password in non-production (email may not be configured).
    const echoPassword = sendEmail && process.env.NODE_ENV !== 'production';
    return NextResponse.json({
      user: { ...user, mustChangePassword: true },
      ...(echoPassword ? { temporaryPassword } : { temporaryPasswordRef: `tirbeo:${user.id}` }),
      supabaseProvisioned: supabase.ok,
      emailSent,
      emailRecipient: recovery || tirbeoEmail,
      note: 'The user must set a new password on first sign in.' }, { status: 201 });
  }

  // Legacy flow: user supplied an explicit email (no Tirbeo username).
  const email = parsed.data.email!.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: { email, passwordHash, isAdmin: adminRole != null },
      select: { id: true, email: true, isAdmin: true, createdAt: true } });
    if (name) await tx.userProfile.create({ data: { userId: u.id, name } });
    await tx.userEmail.create({
      data: { userId: u.id, address: email, kind: 'primary', verifiedAt: new Date(), isDefault: true } });
    await tx.userSecurity.create({ data: { userId: u.id, mustChangePw: true } });
    return { ...u, name: name || null, adminRole: adminRole || null };
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.created',
    targetType: 'user',
    targetId: user.id,
    metadata: { email, adminRole: adminRole || null, temporaryPasswordIssued: true } });

  if (sendEmail) {
    const { sendTemplateEmail } = await import('@/features/email/email');
    const res = await sendTemplateEmail(email, 'welcome', {
      name: name || email.split('@')[0] });
    if (!res.success) {
      console.error(`[ADMIN CREATE USER] Email failed for ${email}: ${res.error}`);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[ADMIN CREATE USER] FALLBACK TEMP PASSWORD for ${email}: ${temporaryPassword}`);
      }
    }
  }

  // Only echo the temporary password in non-production (email may not be configured).
  const echoPassword = sendEmail && process.env.NODE_ENV !== 'production';
  return NextResponse.json({
    user: { ...user, mustChangePassword: true },
    ...(echoPassword ? { temporaryPassword } : {}),
    emailSent: sendEmail,
    note: 'The user must set a new password on first login.' }, { status: 201 });
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
    if (!canManageRole(session.adminRole, existing.isAdmin ? 'admin' : null)) {
      return NextResponse.json({ error: 'Cannot change role of this user' }, { status: 403 });
    }
  }

  // SEC: BAN/SUSPEND is a privileged action — never let an admin act on another
  // admin account.
  if (parsed.data.status === 'BANNED' || parsed.data.status === 'SUSPENDED') {
    if (existing.isAdmin) {
      return NextResponse.json({ error: 'Cannot ban or suspend a super admin' }, { status: 403 });
    }
  }

  const userData: any = {};
  if (parsed.data.adminRole !== undefined) userData.isAdmin = parsed.data.adminRole != null;
  if (parsed.data.status !== undefined) {
    userData.status =
      parsed.data.status === 'BANNED' ? 'banned' :
      parsed.data.status === 'SUSPENDED' ? 'suspended' : 'active';
  }

  if (parsed.data.displayName !== undefined) {
    await prisma.userProfile.upsert({
      where: { userId },
      create: { userId, name: parsed.data.displayName },
      update: { name: parsed.data.displayName } });
  }

  if (Object.keys(userData).length) {
    await prisma.user.update({ where: { id: userId }, data: userData });
  }

  const updated = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      status: true,
      isAdmin: true,
      profile: { select: { name: true, photoUrl: true } } } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.updated',
    targetType: 'user',
    targetId: userId,
    metadata: { changes: parsed.data, previous: { adminRole: existing.isAdmin ? 'admin' : null } } });

  return NextResponse.json({
    id: updated!.id,
    email: updated!.email,
    name: updated!.profile?.name ?? null,
    photoUrl: updated!.profile?.photoUrl ?? null,
    adminRole: updated!.isAdmin ? 'admin' : null,
    isBanned: updated!.status === 'banned',
    isSuspended: updated!.status === 'suspended',
    status: statusLabel(updated!.status) });
}

export async function deleteUser(request: NextRequest, userId: string) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, profile: { select: { name: true } } } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  await prisma.user.delete({ where: { id: userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.deleted',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email, displayName: existing.profile?.name ?? null } });

  return NextResponse.json({ error: 'User deleted' }, { status: 200 });
}



/**
 * Write the enforcement trio for a ban/suspend: flip users.status, add a
 * user_restrictions row, and record a user_status_events row carrying the
 * stable reference code. Reuses the latest matching event's refCode so the
 * code stays stable across re-enforcement, otherwise mints a fresh one.
 *
 * The refCode is ALSO mirrored into activity_events (security.user_banned /
 * security.user_suspended) via logSecurityEvent, so "find this code in the
 * events log" answers with the enforcement event, not only the status row.
 */
async function writeEnforcement(opts: {
  request?: NextRequest;
  userId: string;
  fromStatus: string;
  toStatus: 'banned' | 'suspended';
  title: 'Account banned' | 'Account suspended';
  reason: string | null;
  until?: Date | null;
  refKind: 'ban' | 'suspend';
}): Promise<string> {
  const latest = await prisma.userStatusEvent.findFirst({
    where: { userId: opts.userId, toStatus: opts.toStatus },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true } });
  const refCode = (latest?.metadata as any)?.refCode || generateEventId(opts.refKind);
  const detail = opts.reason || 'No reason provided';

  await prisma.user.update({ where: { id: opts.userId }, data: { status: opts.toStatus } });
  forgetUserStatus(opts.userId);
  await prisma.userRestriction.create({
    data: {
      userId: opts.userId,
      guideline: 'admin-enforcement',
      title: opts.title,
      detail,
      severity: 'strike',
      endsAt: opts.until ?? null } });
  await prisma.userStatusEvent.create({
    data: {
      userId: opts.userId,
      fromStatus: opts.fromStatus as any,
      toStatus: opts.toStatus as any,
      reason: detail,
      actor: 'admin',
      metadata: { refCode, until: opts.until?.toISOString() ?? null } } });

  logSecurityEvent({
    request: opts.request,
    userId: opts.userId,
    eventType: opts.refKind === 'ban' ? 'security.user_banned' : 'security.user_suspended',
    severity: 'warning',
    details: { refCode, until: opts.until?.toISOString() ?? null, reason: detail } }).catch(() => {});

  return refCode;
}

/** Lift an enforcement: status back to active + a status event, no restriction. */
async function liftEnforcement(userId: string, fromStatus: string, reason: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { status: 'active' } });
  forgetUserStatus(userId);
  await prisma.userStatusEvent.create({
    data: {
      userId,
      fromStatus: fromStatus as any,
      toStatus: 'active' as any,
      reason,
      actor: 'admin',
      metadata: {} } });
}

export async function banUser(request: NextRequest, userId: string) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, status: true, isAdmin: true, profile: { select: { name: true } } } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  if (existing.isAdmin) return NextResponse.json({ error: 'Cannot ban a super admin' }, { status: 403 });

  const { reason } = (await request.json().catch(() => ({}))) as any;

  const refCode = await writeEnforcement({ request, userId, fromStatus: existing.status, toStatus: 'banned', title: 'Account banned', reason: reason || 'No reason provided', until: null, refKind: 'ban' });
  await prisma.userSession.deleteMany({ where: { userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.banned',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email, reason: reason || 'No reason provided' } });
  logSecurityEvent({ request, userId, eventType: 'security.account_banned', severity: 'critical', details: { reason: reason || 'No reason provided', byAdmin: session.userId, reference: refCode, account: existing.email }, notifyAdmin: true }).catch(() => {});

  const { sendTemplateEmail } = await import('@/features/email/email');
  const { primaryEmailForUser } = await import('@/features/notifications/notifications');
  const mailTo = (await primaryEmailForUser(userId).catch(() => null)) || existing.email;
  if (mailTo) sendTemplateEmail(mailTo, 'account_suspended', {
    refCode,
    primaryEmail: mailTo,
    name: existing.profile?.name || mailTo,
    statusType: 'permanently banned',
    reason: reason || 'No reason provided',
    suspendedUntil: 'No end date',
    suspendedNextStep: 'Contact support@tirbeo.com if you believe this is a mistake, and quote the reference above.',
    dashboardUrl: (await import('@/config/app-urls')).getDashboardBaseUrl() }, { rawVars: [] }).catch(() => {});

  return NextResponse.json({ message: 'User banned' });
}

export async function unbanUser(request: NextRequest, userId: string) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, status: true } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  await liftEnforcement(userId, existing.status, 'unbanned');

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.unbanned',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email } });
  logSecurityEvent({ request, userId, eventType: 'security.account_unbanned', details: { byAdmin: session.userId } }).catch(() => {});

  return NextResponse.json({ message: 'User unbanned' });
}

export async function suspendUser(request: NextRequest, userId: string) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, status: true, isAdmin: true, profile: { select: { name: true } } } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  if (existing.isAdmin) return NextResponse.json({ error: 'Cannot suspend a super admin' }, { status: 403 });

  const body: any = await request.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'No reason provided';
  const days = Number.isFinite(body.days) ? Math.max(1, Math.min(365, Number(body.days))) : null;
  const until = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;

  const refCode = await writeEnforcement({ request, userId, fromStatus: existing.status, toStatus: 'suspended', title: 'Account suspended', reason, until, refKind: 'suspend' });
  await prisma.userSession.deleteMany({ where: { userId } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.suspended',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email, reason, days } });
  logSecurityEvent({ request, userId, eventType: 'security.account_suspended', severity: 'warning', details: { reason, days, until: until?.toISOString() || null, byAdmin: session.userId, reference: refCode, account: existing.email }, notifyAdmin: true }).catch(() => {});

  const { sendTemplateEmail } = await import('@/features/email/email');
  const { primaryEmailForUser } = await import('@/features/notifications/notifications');
  // A decision about the account has to reach a person, and an account's login
  // handle is a name, not necessarily a mailbox.
  const mailTo = (await primaryEmailForUser(userId).catch(() => null)) || existing.email;
  if (mailTo) sendTemplateEmail(mailTo, 'account_suspended', {
    refCode,
    primaryEmail: mailTo,
    name: existing.profile?.name || mailTo,
    statusType: days ? `suspended for ${days} day${days > 1 ? 's' : ''}` : 'suspended indefinitely',
    reason: reason || 'No reason provided',
    suspendedUntil: until ? until.toUTCString() : 'Until support restores it',
    suspendedNextStep: 'You cannot sign in or use Tirbeo services until then. Quote the reference above if you write about it.',
    dashboardUrl: (await import('@/config/app-urls')).getDashboardBaseUrl() }).catch(() => {});

  return NextResponse.json({ message: 'User suspended', until: until?.toISOString() || null });
}

export async function unsuspendUser(request: NextRequest, userId: string) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, status: true } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  await liftEnforcement(userId, existing.status, 'unsuspended');

  await createAuditEvent({
    actorId: session.userId,
    action: 'user.unsuspended',
    targetType: 'user',
    targetId: userId,
    metadata: { email: existing.email } });
  logSecurityEvent({ request, userId, eventType: 'security.account_unsuspended', details: { byAdmin: session.userId } }).catch(() => {});

  return NextResponse.json({ message: 'User unsuspended' });
}

export async function resolveUserByRefCode(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const code = (request.nextUrl.searchParams.get('code') || '').trim();
  const candidates = refCodeCandidates(code);
  if (!candidates.length) {
    return NextResponse.json({ error: 'Invalid reference code. Expected a format like a1b2-c3d4-e5f6-7a8b.' }, { status: 400 });
  }

  // Reference codes are no longer columns on users — they live in the
  // metadata.refCode of the enforcement status events, of every activity row
  // (stamped at write by the prisma client), and — for sign-in rows, which
  // have no metadata column — in the first 12 hex digits of the row's own id.
  // Match any candidate against all three so a code quoted from any screen
  // finds its user.
  const events = await prisma.userStatusEvent.findMany({
    where: {
      toStatus: { in: [...ENFORCE_STATUSES] },
      OR: candidates.map((c) => ({ metadata: { path: ['refCode'], equals: c } })),
    },
    select: { userId: true },
    orderBy: { createdAt: 'desc' } });

  // No enforcement event carries it — fall through to the general ledger.
  // The compact hex of the typed code also doubles as a uuid prefix: derived
  // refs (xxxx-xxxx-xxxx from a row id) resolve through it on both tables.
  let userIdFromLedger: string | null = null;
  if (!events.length) {
    const hex = code.toLowerCase().replace(/[^0-9a-f]/g, '');
    // A derived ref is the row-id uuid's leading hex digits: 16 today, 12 for
    // codes shown before the widening. Match as deep as the quote goes.
    const idPrefix =
      hex.length >= 16 ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
        : hex.length >= 12 ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-`
        : null;
    const [activityHit, loginHit] = await Promise.all([
      prisma.activityEvent.findFirst({
        where: {
          userId: { not: null },
          OR: [
            ...candidates.map((c) => ({ metadata: { path: ['refCode'], equals: c } })),
            ...(idPrefix ? [{ id: { startsWith: idPrefix } }] : []),
          ],
        },
        select: { userId: true },
        orderBy: { createdAt: 'desc' } }),
      idPrefix
        ? prisma.userLogin.findFirst({
            where: { id: { startsWith: idPrefix } },
            select: { userId: true },
            orderBy: { createdAt: 'desc' } })
        : Promise.resolve(null),
    ]);
    userIdFromLedger = activityHit?.userId ?? loginHit?.userId ?? null;
    if (!userIdFromLedger) {
      return NextResponse.json({ error: 'No user found for that reference code' }, { status: 404 });
    }
  }

  const resolvedUserId = events.length ? events[0].userId : userIdFromLedger!;
  const user = await prisma.user.findUnique({
    where: { id: resolvedUserId },
    select: ADMIN_USER_SELECT });
  if (!user) {
    return NextResponse.json({ error: 'No user found for that reference code' }, { status: 404 });
  }

  const { events: evs, restrictions } = await loadEnforcement([user.id]);
  const shaped = await shapeUserRow(user, evs, restrictions);

  return NextResponse.json({
    user: {
      ...shaped,
      lastActiveAt: user.lastActiveAt?.toISOString() || null } });
}





export async function seedAdminHandler(request: NextRequest) {
  // SEC: gate the seed account behind an admin session.
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
  const isAdmin = adminRole != null;

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!existing) {
    if (!passwordHash) {
      return NextResponse.json({ error: 'A password is required when creating the seed admin' }, { status: 400 });
    }
    await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { email, passwordHash: passwordHash!, isAdmin } });
      await tx.userProfile.create({ data: { userId: u.id, name: email.split('@')[0] } });
    });
    return NextResponse.json({ message: `User ${email} created with role ${adminRole}` });
  }

  await prisma.user.update({
    where: { email },
    data: { isAdmin, ...(passwordHash ? { passwordHash } : {}) } });

  return NextResponse.json({ message: `User ${email} promoted to ${adminRole}${password ? ' with new password' : ''}` });
}

export async function resetUserPassword(request: NextRequest, userId: string) {
  const session = await requireAdmin(request);
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
    data: { passwordHash } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'password.reset',
    targetType: 'user',
    targetId: userId,
    metadata: { from: 'admin_panel', resetBy: 'super_admin' } });

  // Notify the user that their password was reset by an admin
  const { createNotification } = await import('@/features/notifications/notifications');
  createNotification({
    userId,
    type: 'security',
    title: 'Password reset by administrator',
    body: 'Your password was reset by an administrator. If you did not request this, contact support immediately.',
    link: '/settings/security' }).catch(() => {});

  // Revoke all existing sessions so a compromised session can't outlive the reset
  const { revokeSessionFamilyByUser } = await import('@/features/auth/session');
  await revokeSessionFamilyByUser(userId).catch(() => {});

  return NextResponse.json({ message: 'Password reset successfully' });
}



export async function getStats(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const [userCount, auditCount, blocklistCount] = await Promise.all([
    prisma.user.count(),
    prisma.activityEvent.count(),
    prisma.blocklist.count(),
  ]);

  const adminUsers = await prisma.user.findMany({
    where: { isAdmin: true },
    select: { id: true, email: true, profile: { select: { name: true } } } });

  return cachedJson({
    counts: { users: userCount, auditEvents: auditCount, blocked: blocklistCount },
    adminUsers: adminUsers.map(u => ({ id: u.id, email: u.email, name: u.profile?.name ?? null, adminRole: 'admin' })) }, { ttl: 15, swr: 120 });
}
