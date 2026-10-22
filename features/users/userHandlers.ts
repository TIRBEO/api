import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { requireReauth } from '@/features/auth/reauth';
import { maskEmail } from '@/features/auth/recovery-email';
import { hashPassword, verifyPassword } from '@/features/auth/password';
import { generateOtpCode, storeOtp, verifyOtpCode, sendEmailOtp } from '@/features/auth/otp';
import { jsonUnauthorized } from '@/shared/response';
import { imageBytesMatchType } from '@/features/media/imageSecurity';
import { sendTemplateEmailAfter } from '@/features/email/email';
import { createNotification, describeDevice, deviceDetail, primaryEmailForUser, getClientIpFromRequest, loadNotificationPrefs, saveNotificationPrefs, serializedPrefsWrite } from '@/features/notifications/notifications';
import { sanitizeInput } from '@/features/security/security';
import { verifyMergeToken } from '@/features/auth/jwt';
import { bustProfileCache, getOauthProviderConfig } from '@/features/auth/authHandlers';
import { createTtlCache } from '@/infrastructure/cache';
import { logPerformance } from '@/infrastructure/observability/perf';
import { trackQuery } from '@/infrastructure/observability/queryMonitor';
import { createAuditEvent, humanTitle } from '@/features/security/audit';
import { coordsByLoginAttempt } from '@/features/security/loginCoords';
import { logSecurityEvent, notifyAdmins } from '@/features/security/security';
import { originFromRequest } from '@/features/activity/recordChange';
import {
  FORBIDDEN_SETTINGS_KEYS, SETTINGS_LIMITS, containsForbiddenSettingsKey,
  isStorableSettingsValue, settingsBagBytes } from '@/features/users/settingsBag';
import { readRecoveryContact, setRecoveryContact } from '@/features/identity/tirbeo';
import { revokeLongLivedSessions } from '@/features/auth/session';
import { secondFactorBlocker } from '@/features/auth/second-factor';
import {
  PROVIDER_NAMES, isProviderKey,
  listConnections, unlinkProvider, writeOauthLink, readOauthLinks,
  issueDeletionCode, consumeDeletionCode, scheduleDeletion, cancelDeletion,
  activeDeletionFor, OTP_TTL_MINUTES } from '@/features/status/accountLifecycle';
import { ensureRefCode, eventRowRef, refFromRowId } from '@/features/users/refcode';
import {
  CHANGE_ANSWER_KIND as ANSWER_KIND,
  answerIndex,
  type ChangeAnswerValue,
} from '@/features/users/change-answers';
import {
  completeExportRequest,
  createExportRequest,
  exportFileName,
  failExportRequest,
  listExportRequests,
  loadExportRequest,
  parseRequestedExportFormat,
  renderExportArchive,
  type ExportFormat,
  type ExportRequestRecord } from '@/features/users/exportRequests';

// The dashboard polls notifications; 30s TTL keeps the poll cheap without
// making notifications feel stale (poll interval is 15s).
const notificationsCache = createTtlCache<{ notifications: any[]; unread: number; total: number }>(30_000, 2000, 'notifications');

// Request deduplication: if multiple concurrent GET requests hit the same cache key,
// only one makes the actual DB query — the others wait and share the result.
const inFlightNotifications = new Map<string, Promise<{ notifications: any[]; unread: number; total: number }>>();

export function bustNotificationsCache(userId: string) {
  // Per-user bust — keep other users' cache hot for fast reads
  const prefix = `notif:${userId}:`;
  (notificationsCache as any).deleteByPrefix?.(prefix);
  // Fallback if deleteByPrefix missing (old cache)
  if (!(notificationsCache as any).deleteByPrefix) notificationsCache.clear();
  for (const k of Array.from(inFlightNotifications.keys())) if (k.startsWith(prefix)) inFlightNotifications.delete(k);
}

// Cache for GET /api/preferences — dashboard polls this on every page load.
// 10s TTL: preferences rarely change, and bust on PATCH.
const preferencesCache = createTtlCache<any>(10_000, 2000, 'preferences');
const PREFS_CACHE_KEY = (userId: string) => `prefs:${userId}`;

/** Cleared on every write this file makes to `appearance`/`privacy`, so the
 *  settings screen never shows the value the account just changed. Onboarding
 *  writes `appearance` too, from a module that cannot import this one without a
 *  cycle — there the 10s TTL is the bust, and the staleness is a person's own
 *  theme choice they just picked. */
export function bustPreferencesCache(userId: string) {
  preferencesCache.delete(PREFS_CACHE_KEY(userId));
}

// Cache for GET /api/user/activity — activity page polls this.
// 5s TTL: activity logs are append-only and stale data is acceptable.
const activityCache = createTtlCache<{ events: any[]; total: number }>(5_000, 2000, 'activity');

// Cache for GET /api/profile/public — public profiles rarely change.
// 30s TTL: safe for public data, busts naturally.
const publicProfileCache = createTtlCache<any>(30_000, 2000, 'publicProfile');

const PROFILE_FIELD_LABELS: Record<string, string> = {
  name: 'Display name', username: 'Username', photoUrl: 'Profile photo',
  phoneNumber: 'Phone number', bio: 'Bio',
  website: 'Website', timezone: 'Timezone',
  language: 'Language', theme: 'Theme',
  companyName: 'Company name', companyRole: 'Job title',
  gender: 'Gender', birthday: 'Birthday',
  secondaryEmail: 'Recovery email' };

/**
 * The profile read, spread over the three tables the rebuild split it across:
 * `users` (the account itself), `user_profile` (what a person fills in about
 * themselves) and `user_phone`. Everything is read in one `findUnique` and
 * flattened into the wire object this endpoint has always returned, so a
 * caller that never learned about the split sees no difference.
 *
 * The keys that no longer exist anywhere — occupation, linkedin,
 * githubUsername, twitter, country, dateFormat, timeFormat, industry,
 * companySize — are absent rather than answered with a stand-in. The rebuild
 * dropped them, and returning "" for a field nobody stores would be claiming a
 * value the account does not have.
 */
const PROFILE_SELECT = {
  id: true, email: true, username: true, status: true,
  lastLoginAt: true, lastActiveAt: true, createdAt: true, updatedAt: true,
  passwordHash: true,
  profile: {
    select: {
      name: true, photoUrl: true,
      bio: true, gender: true, birthday: true, website: true,
      jobRole: true, jobCompany: true, pronouns: true, location: true } },
  preferences: { select: { appearance: true, misc: true } },
  phone: { select: { number: true, verifiedAt: true } },
  security: { select: { totpEnabled: true, mustChangePw: true, backupCodes: true } },
  emails: { select: { address: true, kind: true, isDefault: true, verifiedAt: true } },
  deletionRequest: { select: { reason: true, finalAt: true, cancelledAt: true, executedAt: true } } } as const;

/**
 * Wire field name → `user_profile` column. `name`/`photoUrl` read from here now
 * that the account row keeps only identity; the two employment keys differ
 * because the column was named for the job sense of the word and the wire kept
 * the name the settings form has always used.
 */
const PROFILE_ROW_FIELDS: Record<string, string> = {
  name: 'name',
  photoUrl: 'photoUrl',
  bio: 'bio',
  gender: 'gender',
  website: 'website',
  companyName: 'jobCompany',
  companyRole: 'jobRole',
  pronouns: 'pronouns',
  location: 'location' };

/**
 * Fields that stay on the `users` row itself. Every other concern has moved to
 * its own table: name/photoUrl → user_profile, theme/language/timezone →
 * user_preferences.appearance.
 */
const ACCOUNT_ROW_FIELDS = ['username'] as const;

/** Wire field names that map to the `user_preferences.appearance` JSON. */
const APPEARANCE_ROW_FIELDS = ['theme', 'timezone', 'language'] as const;

type ProfileWire = Record<string, any>;

/** One read, one shape. `null` means the account is gone. */
async function readProfileState(userId: string): Promise<{ wire: ProfileWire; flags: Record<string, boolean | number> } | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT });
  if (!user) return null;
  const p = user.profile;
  const appearance = (user.preferences?.appearance && typeof user.preferences.appearance === 'object' ? user.preferences.appearance : {}) as Record<string, any>;
  const misc = (user.preferences?.misc && typeof user.preferences.misc === 'object' ? user.preferences.misc : {}) as Record<string, any>;
  const consents = (misc.consents && typeof misc.consents === 'object' ? misc.consents : {}) as Record<string, unknown>;
  const oauth = (misc.oauth && typeof misc.oauth === 'object' ? misc.oauth : {}) as Record<string, string>;
  const security = user.security;
  const backupCodes = security?.backupCodes as unknown;
  const emailRow = user.emails.find((e) => e.address === user.email)
    || user.emails.find((e) => e.isDefault)
    || user.emails.find((e) => e.kind === 'primary');
  const dr = user.deletionRequest;
  const deletionActive = user.status === 'deletion_pending' && !!dr && !dr.cancelledAt && !dr.executedAt;
  return {
    wire: {
      id: user.id,
      email: user.email,
      username: user.username,
      name: p?.name ?? null,
      photoUrl: p?.photoUrl ?? null,
      status: user.status,
      theme: appearance.theme ?? 'system',
      timezone: appearance.timezone ?? null,
      language: appearance.language ?? 'en',
      consents,
      emailVerified: emailRow?.verifiedAt != null,
      phoneVerified: user.phone?.verifiedAt != null,
      phoneVerifiedAt: user.phone?.verifiedAt ?? null,
      is2FAEnabled: !!security?.totpEnabled,
      mustChangePassword: !!security?.mustChangePw,
      scheduledDeletionAt: deletionActive ? dr!.finalAt : null,
      deletionReason: deletionActive ? (dr!.reason ?? null) : null,
      lastLoginAt: user.lastLoginAt,
      lastActiveAt: user.lastActiveAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      bio: p?.bio ?? null,
      gender: p?.gender ?? null,
      website: p?.website ?? null,
      birthday: p?.birthday ?? null,
      pronouns: p?.pronouns ?? null,
      location: p?.location ?? null,
      companyName: p?.jobCompany ?? null,
      companyRole: p?.jobRole ?? null,
      phoneNumber: user.phone?.number ?? null },
    flags: {
      hasPassword: !!user.passwordHash,
      hasGoogle: !!oauth.google,
      hasGithub: !!oauth.github,
      hasDiscord: !!oauth.discord,
      totpEnabled: !!security?.totpEnabled,
      recoveryCodesCount: Array.isArray(backupCodes) ? backupCodes.length : 0 } };
}

export async function extendedProfileHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    if (request.method === 'GET') {
      const state = await readProfileState(session.userId);
      if (!state) return NextResponse.json({ error: 'User not found' }, { status: 404 });
      const recoveryContact = await readRecoveryContact(session.userId);
      return NextResponse.json({
        ...state.wire,
        ...state.flags,
        recoveryEmail: recoveryContact?.email ?? null,
        recoveryEmailVerified: !!recoveryContact?.verified,
        recoveryPhone: state.wire.phoneNumber || undefined,
        skipPassword: !!(state.wire.consents as Record<string, unknown>)?.skipPassword,
        phones: state.wire.phoneNumber
          ? [{ number: state.wire.phoneNumber, verified: state.wire.phoneVerified }]
          : [],
        lastPasswordChange: state.wire.updatedAt?.toISOString() || null });
    }

    if (request.method === 'PATCH' || request.method === 'PUT') {
      const body: any = await request.json();
      const schema = z.object({
        name: z.string().min(1).optional(),
        username: z.string().optional().nullable(),
        photoUrl: z.string().optional().nullable(),
        phoneNumber: z.string().optional().nullable(),
        occupation: z.string().optional().nullable(),
        bio: z.string().optional().nullable(),
        website: z.string().optional().nullable(),
        linkedin: z.string().optional().nullable(),
        github: z.string().optional().nullable(),
        githubUsername: z.string().optional().nullable(),
        twitter: z.string().optional().nullable(),
        country: z.string().optional().nullable(),
        timezone: z.string().optional().nullable(),
        language: z.string().optional().nullable(),
        theme: z.enum(['light', 'dark', 'system']).optional().nullable(),
        dateFormat: z.string().optional().nullable(),
        timeFormat: z.string().optional().nullable(),
        companyName: z.string().optional().nullable(),
        companyRole: z.string().optional().nullable(),
        industry: z.string().optional().nullable(),
        companySize: z.string().optional().nullable(),
        gender: z.string().optional().nullable(),
        birthday: z.string().optional().nullable(),
        secondaryEmail: z.string().optional().nullable(),
        pronouns: z.string().max(40).optional().nullable(),
        location: z.string().max(120).optional().nullable() }).passthrough();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        console.error('[PATCH /api/profile] Zod validation error:', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
        return NextResponse.json({ error: 'Invalid preferences data', details: parsed.error.issues }, { status: 400 });
      }
      const raw: any = { ...parsed.data };
      // Keys the rebuild left without a home (occupation, linkedin, github /
      // githubUsername, twitter, country, dateFormat, timeFormat, industry,
      // companySize) are accepted and dropped. They stay in the schema so a
      // client still submitting the pre-rebuild form is not rejected outright;
      // none of them is a column any more, so there is nowhere to put the value.
      const accountData: Record<string, unknown> = {};
      for (const field of ACCOUNT_ROW_FIELDS) {
        if (raw[field] !== undefined) accountData[field] = raw[field];
      }

      const profileData: Record<string, unknown> = {};
      for (const [wireKey, column] of Object.entries(PROFILE_ROW_FIELDS)) {
        if (raw[wireKey] === undefined) continue;
        const value = raw[wireKey];
        profileData[column] = typeof value === 'string' ? sanitizeInput(value, 2000) : value;
      }
      if (raw.birthday !== undefined) {
        if (!raw.birthday || raw.birthday === '') {
          profileData.birthday = null;
        } else {
          const d = new Date(raw.birthday);
          profileData.birthday = isNaN(d.getTime()) ? null : d;
        }
      }

      // Read the current values first, so the change log below reports what
      // actually moved rather than every key that was submitted.
      const before = await readProfileState(session.userId);
      const prev = before?.wire ?? {};

      // A typed number is a contact, not a proven identity, so replacing it
      // drops the proof along with the old number (verifiedAt → null).
      const phoneWrite = raw.phoneNumber !== undefined
        ? { upsert: {
            create: { userId: session.userId, number: raw.phoneNumber || null, verifiedAt: null },
            update: { number: raw.phoneNumber || null, verifiedAt: null } } }
        : null;

      // theme/language/timezone live in the appearance JSON, not on the account.
      const currentAppearance = (await prisma.userPreferences
        .findUnique({ where: { userId: session.userId }, select: { appearance: true } })
        .then((r) => (r?.appearance && typeof r.appearance === 'object' ? r.appearance : {}))
        .catch(() => ({}))) as Record<string, any>;
      const nextAppearance: Record<string, any> = { ...currentAppearance };
      let appearanceChanged = false;
      for (const field of APPEARANCE_ROW_FIELDS) {
        if (raw[field] !== undefined) { nextAppearance[field] = raw[field]; appearanceChanged = true; }
      }

      if (Object.keys(accountData).length > 0 || Object.keys(profileData).length > 0 || phoneWrite) {
        await prisma.user.update({
          where: { id: session.userId },
          data: {
            ...accountData,
            ...(Object.keys(profileData).length > 0
              ? { profile: { upsert: { create: profileData, update: profileData } } }
              : {}),
            ...(phoneWrite ? { phone: phoneWrite } : {}) },
          select: { id: true } });
      }

      if (appearanceChanged) {
        await prisma.userPreferences.upsert({
          where: { userId: session.userId },
          create: { userId: session.userId, appearance: nextAppearance as any },
          update: { appearance: nextAppearance as any } });
        bustPreferencesCache(session.userId);
      }

      // What this write intended, in wire terms, so it can be diffed against
      // what was read a moment ago.
      const next: ProfileWire = {};
      for (const field of ACCOUNT_ROW_FIELDS) {
        if (field in accountData) next[field] = accountData[field];
      }
      for (const [wireKey, column] of Object.entries(PROFILE_ROW_FIELDS)) {
        if (column in profileData) next[wireKey] = profileData[column];
      }
      for (const field of APPEARANCE_ROW_FIELDS) {
        if (field in nextAppearance) next[field] = nextAppearance[field];
      }
      if ('birthday' in profileData) next.birthday = profileData.birthday;
      if (raw.phoneNumber !== undefined) next.phoneNumber = raw.phoneNumber || null;

      // The recovery address is a `user_email` row of kind 'recovery' — that is
      // what a verification code proves and what a recovery would be sent to.
      if (raw.secondaryEmail !== undefined) {
        const address = typeof raw.secondaryEmail === 'string' ? raw.secondaryEmail.trim() : '';
        if (address) {
          // A typed address is a contact, not a proven identity — it stays
          // unverified until a code confirms it.
          await setRecoveryContact({ userId: session.userId, email: address, verifiedBy: null, verifiedAt: null });
          next.secondaryEmail = address;
        } else {
          await prisma.userEmail.deleteMany({
            where: { userId: session.userId, kind: { in: ['recovery', 'secondary'] } } });
          next.secondaryEmail = null;
        }
      }

      const same = (a: any, b: any) => {
        if (a instanceof Date || b instanceof Date) return new Date(a as any).getTime() === new Date(b as any).getTime();
        return (a ?? null) === (b ?? null) || String(a ?? '') === String(b ?? '');
      };
      // Only fields that actually changed value (NOT every submitted key).
      const changedFields = Object.keys(next).filter((f) => !same(prev[f], next[f]));

      if (changedFields.length > 0) {
        bustProfileCache(session.userId);
        /* Every row this write produces happened on the same machine, in the
           same place, at the same moment — so it is worked out once. Without
           it the history page can say a field changed but not who changed it
           from where, which is the half of the record a person reads. */
        const origin = originFromRequest(request.headers);
        for (const field of changedFields) {
          const label = PROFILE_FIELD_LABELS[field] ?? field.replace(/([A-Z])/g, ' $1').trim();
          const rawValue = next[field];
          const displayValue = rawValue instanceof Date
            ? new Date(rawValue).toISOString().split('T')[0]
            : (rawValue ?? null);
          const hasValue = displayValue !== null && String(displayValue) !== '';

          // Separate, accurate activity log per changed field
          createAuditEvent({
            actorId: session.userId,
            action: `profile.${field}.updated`,
            title: `${label} updated`,
            targetType: 'user',
            targetId: session.userId,
            metadata: { field, fields: [label], from: prev[field] ?? null, to: displayValue },
            severity: 'info',
            ...origin }).catch((e) => console.error('[ACTIVITY]', e?.message));

          // Separate, accurate notification per changed field
          createNotification({
            userId: session.userId,
            type: 'system',
            title: `${label} updated`,
            body: hasValue
              ? `Your ${label.toLowerCase()} was changed to "${displayValue}".`
              : `Your ${label.toLowerCase()} was removed.`,
            link: '/settings/edit-profile',
            metadata: { field, from: prev[field] ?? null, to: displayValue } }).catch((e) => console.error('[NOTIFICATION]', e?.message));
        }
      }

      // Answer with the profile as it now stands, in the same shape GET uses —
      // a caller that just wrote a field should read back what was stored, not
      // a hand-built echo of what it sent.
      const after = await readProfileState(session.userId);
      if (!after) return NextResponse.json({ error: 'User not found' }, { status: 404 });
      return NextResponse.json({ ...after.wire, ...after.flags });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[EXTENDED PROFILE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}

export async function changePasswordHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body: any = await request.json();
    const { currentPassword, newPassword } = body;
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, passwordHash: true } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    if (user.passwordHash) {
      // User has a password — require currentPassword
      if (!currentPassword) {
        return NextResponse.json({ error: 'Current password required' }, { status: 400 });
      }
      if (!(await verifyPassword(user.passwordHash, currentPassword))) {
        return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 });
      }
    }
    // Passwordless (OAuth) account: email already verified by the provider —
    // no OTP or current password needed to set the first password.

    // require2FA ON: the password is only the first factor — a fresh second
    // factor (authenticator or backup code) must ride along with the change.
    const secondFactorBlocked = await secondFactorBlocker(session.userId, body);
    if (secondFactorBlocked) return secondFactorBlocked;

    const { checkPasswordBreach } = await import('@/features/auth/breach');
    const breach = await checkPasswordBreach(newPassword);
    if (breach.breached) {
      return NextResponse.json({ error: 'This password has been found in known breaches. Please choose a different password.' }, { status: 400 });
    }

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: session.userId }, data: { passwordHash: newHash } });
    await prisma.userSecurity.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId, mustChangePw: false },
      update: { mustChangePw: false } });
    await prisma.userSession.deleteMany({
      where: { userId: session.userId, NOT: { id: session.sessionId } } });
    logSecurityEvent({ request, userId: session.userId, eventType: 'security.password_changed', details: { method: 'password' } }).catch(() => {});

    /* The account's own mailbox, not its login name: for a handle account
       `user.email` is `<handle>@tirbeo.com`, and a "your password changed"
       warning that lands there warns nobody. */
    const userEmail = (await primaryEmailForUser(session.userId).catch(() => null))
      || (await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } }))?.email || '';
    if (userEmail) {
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
      sendTemplateEmailAfter(userEmail, 'password_changed', {
        name: userEmail.split('@')[0],
        changedAt: new Date().toLocaleString(),
        ipAddress: ip });
    }

    const loginIp = getClientIpFromRequest(request);
    const loginDevice = describeDevice(request.headers.get('user-agent'));
    await createNotification({
      userId: session.userId,
      type: 'security',
      title: 'Password changed',
      body: `Your password was changed from ${loginDevice} (IP ${loginIp || 'unknown'}). All other sessions were signed out.`,
      link: '/settings/security',
      metadata: { ip: loginIp, device: loginDevice, method: 'Password' },
      skipEmail: true }).catch((e) => console.error('[NOTIFICATION]', (e as Error)?.message));


    // Success in the body, not in a field named error: every client of this
    // endpoint shows `error` to the person, and "Password changed" as a
    // failure message is exactly the sort of thing that makes a security screen
    // untrustworthy.
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[CHANGE PASSWORD]', err?.message || err);
    return NextResponse.json({ error: 'Failed to change password' }, { status: 500 });
  }
}

export async function sessionsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    if (request.method === 'GET') {
      // user_sessions has no status column in practice: the revoke paths stamp
      // revokedAt and leave `status` at its default, so filtering on status
      // shows signed-out machines forever. revokedAt + expiresAt is the real
      // definition of a live session.
      const sessions = await prisma.userSession.findMany({
        where: { userId: session.userId, revokedAt: null, expiresAt: { gte: new Date() } },
        orderBy: { lastUsedAt: 'desc' },
        select: { id: true, userAgent: true, ipAddress: true, location: true, createdAt: true, expiresAt: true, lastUsedAt: true } });
      /* The session row has a place name but no point; the sign-in that
         opened it did. Pair them so a device's map draws from real
         coordinates or not at all. */
      const coords = await coordsByLoginAttempt(
        session.userId,
        sessions.map((s) => ({ ip: s.ipAddress, at: s.createdAt })));
      const currentSessionId = session.sessionId;
      const result = sessions.map((s, i) => ({
        id: s.id,
        userAgent: s.userAgent,
        device: s.userAgent || 'Unknown device',
        ipAddress: s.ipAddress,
        location: s.location,
        coords: coords[i],
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        lastSeenAt: s.lastUsedAt || s.createdAt,
        isCurrent: s.id === currentSessionId }));
      if (!currentSessionId || currentSessionId === 'cli') {
        result.unshift({ id: 'cli', userAgent: 'Tirbeo CLI', device: 'Tirbeo CLI', ipAddress: null, location: null, coords: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), lastSeenAt: new Date(), isCurrent: true });
      }
      return NextResponse.json(result);
    }

    if (request.method === 'DELETE') {
      // Accept sessionId from body, query param, or URL search params
      let sessionId: string | undefined;
      try { const body: any = await request.json(); sessionId = body?.sessionId; } catch { /* no body */ }
      if (!sessionId) sessionId = request.nextUrl.searchParams.get('sessionId') || undefined;
      if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
      if (sessionId === session.sessionId) return NextResponse.json({ error: 'Cannot terminate current session' }, { status: 400 });
      const targetSession = await prisma.userSession.findUnique({ where: { id: sessionId } });
      if (!targetSession || targetSession.userId !== session.userId) {
        return NextResponse.json({ error: 'Session not found' }, { status: 404 });
      }
      // Use deleteMany to be idempotent — session may already be revoked/deleted
      await prisma.userSession.deleteMany({ where: { id: sessionId, userId: session.userId } });
      return NextResponse.json({ ok: true, message: 'Session terminated' });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[SESSIONS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}

export async function notificationsHandler(request: NextRequest) {
  const startTime = performance.now();
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    if (request.method === 'GET') {
      const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get('limit')) || 20, 1), 100);
      const offset = Math.max(0, Number(request.nextUrl.searchParams.get('offset')) || 0);
      const cacheKey = `notif:${session.userId}:${limit}:${offset}`;
      const cached = notificationsCache.get(cacheKey);
      if (cached) return NextResponse.json(cached);

      // Request deduplication: if another request is already fetching this data,
      // wait for it instead of making a duplicate DB query.
      const existing = inFlightNotifications.get(cacheKey);
      if (existing) {
        const body = await existing;
        logPerformance('notifications/dedup', startTime);
        return NextResponse.json(body);
      }

      // Create the promise and store it for deduplication
      const fetchPromise = (async () => {
        try {
          // Counts + paginated fetch in parallel instead of 3 sequential queries
          const [countResult, notifications] = await Promise.all([
            prisma.$queryRaw`
              SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_read = false)::int AS unread
              FROM "public"."notifications"
              WHERE user_id = ${session.userId}
            `,
            trackQuery('notifications_by_user_created', () => prisma.notification.findMany({
              where: { userId: session.userId },
              orderBy: { createdAt: 'desc' },
              take: limit,
              skip: offset,
              select: { id: true, type: true, title: true, body: true, link: true, icon: true, isRead: true, metadata: true, createdAt: true } })),
          ]);
          const { total, unread } = (countResult as any[])[0] || { total: 0, unread: 0 };
          const items = notifications.map((n: any) => ({ ...n, read: n.isRead }));
          const body = { notifications: items, unread, total };
          notificationsCache.set(cacheKey, body);
          return body;
        } finally {
          inFlightNotifications.delete(cacheKey);
        }
      })();

      inFlightNotifications.set(cacheKey, fetchPromise);
      const body = await fetchPromise;
      logPerformance('notifications', startTime);
      return NextResponse.json(body);
    }

    if (request.method === 'PATCH') {
      const body: any = await request.json();
      const { notificationIds, markAll, markAllRead } = body;
      if (markAll || markAllRead) {
        await prisma.notification.updateMany({ where: { userId: session.userId, isRead: false }, data: { isRead: true } });
      } else if (notificationIds && Array.isArray(notificationIds)) {
        await prisma.notification.updateMany({ where: { id: { in: notificationIds }, userId: session.userId }, data: { isRead: true } });
      }
      bustNotificationsCache(session.userId);
      return NextResponse.json({ ok: true, message: 'Notifications updated' });
    }

    if (request.method === 'DELETE') {
      const id = request.nextUrl.searchParams.get('id');
      if (id) {
        await prisma.notification.deleteMany({ where: { id, userId: session.userId } });
      } else {
        // Support body-based bulk delete { notificationIds: [...] }
        let bodyIds: string[] | null = null;
        try {
          const b: any = await request.json();
          if (b?.notificationIds && Array.isArray(b.notificationIds)) bodyIds = b.notificationIds;
        } catch { /* no body */ }
        if (bodyIds && bodyIds.length > 0) {
          await prisma.notification.deleteMany({ where: { id: { in: bodyIds }, userId: session.userId } });
        } else {
          await prisma.notification.deleteMany({ where: { userId: session.userId } });
        }
      }
      bustNotificationsCache(session.userId);
      return NextResponse.json({ ok: true, message: 'Notifications deleted' });
    }

    logPerformance('notifications', startTime);
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[NOTIFICATIONS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}

const PREF_FREQUENCIES = ['daily', 'weekly', 'monthly'];

/**
 * Every notification-preferences endpoint is the same thing: a filter over a few
 * keys, one merged read, one write. They are built from one factory because each
 * used to merge the account column by hand — which is how a choice made on one
 * screen stayed invisible to a sender reading the other store.
 */
function prefsEndpoint(
  keys: string[],
  options: { validate?: (patch: Record<string, unknown>) => string | null } = {},
) {
  const allowed = new Set(keys);
  return async function handlePrefs(request: NextRequest) {
    try {
      const session = await getSession(request);
      if (!session) return jsonUnauthorized();

      const shape = (prefs: Record<string, any>) => {
        const out: Record<string, any> = { ok: true };
        for (const key of allowed) out[key] = prefs[key];
        return out;
      };

      if (request.method === 'GET') return NextResponse.json(shape(await loadNotificationPrefs(session.userId)));
      if (request.method !== 'PUT') return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });

      const body: any = await request.json().catch(() => ({}));
      const patch: Record<string, unknown> = {};
      for (const key of Object.keys(body)) if (allowed.has(key)) patch[key] = body[key];
      const problem = options.validate?.(patch);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });

      let finalPatch: Record<string, unknown> = patch;
      // Re-enabling mail is also the moment the one-click unsubscribe from an
      // earlier email stops applying.
      if (patch.email === true) {
        const current = await loadNotificationPrefs(session.userId);
        const eu: any = (current.unsubscribed && typeof current.unsubscribed === 'object' && !Array.isArray(current.unsubscribed)) ? current.unsubscribed : {};
        if (eu.all || eu.product || eu.forms || eu.support) {
          finalPatch = { ...patch, unsubscribed: { ...eu, all: false, product: false, forms: false, support: false } };
        }
      }
      const saved = await saveNotificationPrefs(session.userId, finalPatch);
      return NextResponse.json(shape(saved));
    } catch (err: any) {
      console.error('[NOTIFICATION_PREFS]', err?.message || err);
      return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
    }
  };
}

export const notificationChannelsHandler = prefsEndpoint(['email', 'push']);

/**
 * A pause that ends at nothing is a real number or nothing at all. Anything
 * else would read as "unpaused" to isEmailPaused while the screen still shows
 * the switch on, so the person keeps getting mail they believe they stopped.
 */
function validatePrefs(patch: Record<string, unknown>): string | null {
  if (patch.summaryFrequency !== undefined && !PREF_FREQUENCIES.includes(String(patch.summaryFrequency))) {
    return 'Invalid summaryFrequency';
  }
  if (patch.emailPausedUntil !== undefined && patch.emailPausedUntil !== null
      && !(typeof patch.emailPausedUntil === 'number' && Number.isFinite(patch.emailPausedUntil))) {
    return 'Invalid emailPausedUntil';
  }
  if (patch.quietHoursEnabled !== undefined && typeof patch.quietHoursEnabled !== 'boolean') {
    return 'Invalid quietHoursEnabled';
  }
  for (const key of ['quietHoursStart', 'quietHoursEnd'] as const) {
    if (patch[key] !== undefined
        && !(typeof patch[key] === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(patch[key]))) {
      return `Invalid ${key}`;
    }
  }
  return null;
}

export const notificationCategoriesHandler = prefsEndpoint([
  // Only the tips master survives here — it is the one category-level switch
  // a send path reads. The forms/product/support/offers masters were stored
  // and ignored; the screens decide through the channel keys.
  'tips',
  'formsEmail', 'formsPush', 'productEmail', 'productPush', 'supportEmail', 'supportPush', 'tipsEmail', 'tipsPush',
  'offersEmail', 'offersPush',
  // "Pause everything at once" lives with the categories it quiets.
  'emailPaused', 'emailPausedUntil',
  'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd',
], { validate: validatePrefs });

/** The account recap: whether it comes at all, and how often. */
export const notificationSummaryHandler = prefsEndpoint(['summaryEnabled', 'summaryFrequency'], {
  validate: (patch) => {
    const problem = validatePrefs(patch);
    if (problem) return problem;
    if (patch.summaryEnabled !== undefined && typeof patch.summaryEnabled !== 'boolean') return 'Invalid summaryEnabled';
    return null;
  } });

export const notificationTipsHandler = prefsEndpoint(['tips', 'tipsEmail', 'tipsPush']);

// Provider identity (which OAuth providers exist, their names, the union read
// over misc.oauth + the legacy columns, and the guarded unlink) lives in the
// account-lifecycle module so the settings screen, the admin unlink and the
// sign-in guard all read one source of truth.

export async function oauthUnlinkHandler(request: NextRequest, provider: string) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    if (!isProviderKey(provider)) return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 });

    const refusal = await unlinkProvider(session.userId, provider);
    if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });

    createNotification({
      userId: session.userId,
      type: 'security',
      title: 'Account disconnected',
      body: `Your ${provider} account was unlinked from Tirbeo. You can no longer sign in with it until you reconnect it.`,
      link: '/settings/connected-apps' }).catch((e) => console.error('[NOTIFICATION]', e?.message));

    return NextResponse.json({ ok: true, message: `${provider} disconnected` });
  } catch (err: any) {
    console.error('[OAUTH UNLINK]', err?.message || err);
    return NextResponse.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }
}

/**
 * The account's own OAuth links — what "Connected apps" is made of.
 *
 * GET carries the whole truth the screen needs: which providers are linked,
 * the id they were linked under, and the first/last time the account actually
 * signed in through them (from the login ledger — a link that has never been
 * used says so rather than inventing a date). DELETE removes a link and files
 * the revocation in the security feed, so "disconnected recently" is something
 * the account remembers rather than the browser it happened to be done on.
 */
export async function integrationsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    // The read is preferences.misc.oauth, with the link date the OAuth callback
    // filed as an `oauth.<provider>.connected` event.
    const readConnections = () => listConnections(session.userId);

    if (request.method === 'GET') {
      return NextResponse.json(await readConnections());
    }

    const body: any = await request.json().catch(() => ({}));
    const provider = body?.provider || request.nextUrl.searchParams.get('provider');

    if (request.method === 'DELETE') {
      // Revoking a sign-in link takes away a way back in, so a session cookie
      // alone must not be enough: the request carries a fresh identity proof.
      // The body this handler already read is handed to the guard, so the proof
      // and the provider come from the one read.
      const proof = await requireReauth(request, session.userId, { body });
      if ('response' in proof) return proof.response;

      if (!isProviderKey(provider)) return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 });
      const refusal = await unlinkProvider(session.userId, provider);
      if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });

      logSecurityEvent({
        request,
        userId: session.userId,
        eventType: 'security.app_disconnected',
        severity: 'warning',
        details: { provider, providerName: PROVIDER_NAMES[provider] } }).catch(() => {});

      createNotification({
        userId: session.userId,
        type: 'security',
        title: `${PROVIDER_NAMES[provider]} disconnected`,
        body: `Your ${PROVIDER_NAMES[provider]} sign-in link was removed.`,
        link: '/settings/connected-apps' }).catch((e) => console.error('[NOTIFICATION]', e?.message));
      return NextResponse.json({ ok: true, connections: await readConnections() });
    }

    if (request.method === 'POST') {
      if (!isProviderKey(provider)) return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 });
      // Connect: hand back the OAuth hop the browser should follow. The link
      // itself is only ever written by the callback at the end of that flow,
      // so nothing here flips a "connected" flag.
      if ((await readConnections()).some((row) => row.provider === provider && row.connected)) {
        return NextResponse.json({ error: 'That app is already connected' }, { status: 409 });
      }
      const cfg = await getOauthProviderConfig(provider);
      if (!cfg.enabled || !cfg.clientId) {
        // Better a sentence than sending the browser to a provider the site
        // has no credentials for, where it lands on a raw error.
        return NextResponse.json(
          { error: `Signing in with ${provider} isn't set up on this site yet.` },
          { status: 503 },
        );
      }
      const baseUrl = (await import('@/config/app-urls')).getApiBaseUrl();
      const redirectUrl = `${baseUrl}/api/auth/${provider}?link=1`;
      return NextResponse.json({ ok: true, redirectUrl });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[INTEGRATIONS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}

export async function mergeAccountsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body: any = await request.json();
    const { merge_token, action } = body;

    if (!merge_token || !action) {
      return NextResponse.json({ error: 'merge_token and action required' }, { status: 400 });
    }

    if (action === 'cancel') {
      return NextResponse.json({ ok: true, action: 'cancelled' });
    }

    if (action !== 'merge') {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    const data = await verifyMergeToken(merge_token);
    if (!data) {
      return NextResponse.json({ error: 'Invalid or expired merge token' }, { status: 400 });
    }

    const { provider, providerId, email, name, photoUrl, existingUserId } = data;

    // Verify the existing user still exists
    const existingUser = await prisma.user.findUnique({ where: { id: existingUserId } });
    if (!existingUser) {
      return NextResponse.json({ error: 'The account to merge with no longer exists' }, { status: 404 });
    }
    if (!isProviderKey(provider)) {
      return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 });
    }

    // Link the provider to the signed-in account. The link is written to the
    // authoritative store (preferences.misc.oauth), so the connection shows up
    // in "Connected apps" and login options reflect it without a reload trick.
    const currentUser = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, profile: { select: { name: true, photoUrl: true } } } });
    if (!currentUser) {
      return NextResponse.json({ error: 'Current account not found' }, { status: 404 });
    }

    await writeOauthLink(session.userId, provider, providerId);

    // Never overwrite an existing name/photo — those are managed from the
    // dashboard profile; provider values only fill EMPTY fields.
    const currentName = currentUser.profile?.name ?? null;
    const currentPhoto = currentUser.profile?.photoUrl ?? null;
    if (!currentPhoto || !currentName) {
      await prisma.userProfile.upsert({
        where: { userId: session.userId },
        create: {
          userId: session.userId,
          ...(currentPhoto ? {} : { photoUrl: photoUrl || null }),
          ...(currentName ? {} : { name: name || null }) },
        update: {
          ...(currentPhoto ? {} : { photoUrl: photoUrl || null }),
          ...(currentName ? {} : { name: name || null }) } });
    }
    bustProfileCache(session.userId);

    // Audit + link-date event. `oauth.<provider>.connected` is the same event
    // the OAuth callback files, so the merged link shows its date like any
    // other connection.
    await prisma.activityEvent.create({
      data: {
        userId: session.userId,
        kind: `oauth.${provider}.connected`,
        title: `${PROVIDER_NAMES[provider]} connected`,
        detail: providerId,
        metadata: { provider, providerName: PROVIDER_NAMES[provider], via: 'merge' },
        severity: 'warning' } }).catch(() => {});

    await prisma.activityEvent.create({
      data: {
        userId: session.userId,
        kind: 'account.merge',
        title: 'Account merge',
        detail: existingUserId,
        metadata: { targetType: 'user', provider, email, mergedFrom: existingUserId, mergedTo: session.userId },
        severity: 'warning' } }).catch(() => {});

    return NextResponse.json({ ok: true, action: 'merged', provider, email, connections: await listConnections(session.userId) });
  } catch (err: any) {
    console.error('[MERGE ACCOUNTS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to merge accounts' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// USER ACTIVITY HANDLER
// ═══════════════════════════════════════════════════════════════════
export async function userActivityHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0'));
    const cacheKey = `activity:${session.userId}:${limit}:${offset}`;
    const cached = activityCache.get(cacheKey);
    if (cached) return NextResponse.json(cached);

    // Fetch enough rows to fill the page after merge+sort.
    // We fetch `limit` per table (not 2000!) since each table uses a composite
    // index on (userId, createdAt DESC) and we only need `limit` rows from each.
    const fetchLimit = Math.min(limit + offset, 200); // hard cap to prevent abuse
    const [auditEvents, securityEvents, loginHistoryRecords, totalCounts] = await Promise.all([
      trackQuery('audit_events_by_actor_created', () => prisma.activityEvent.findMany({
        where: { userId: session.userId },
        orderBy: { createdAt: 'desc' },
        take: fetchLimit,
        select: { id: true, kind: true, detail: true, metadata: true, severity: true, createdAt: true } })),
      trackQuery('security_events_by_user_created', () => prisma.activityEvent.findMany({
        where: { userId: session.userId, kind: { startsWith: 'security.' } },
        orderBy: { createdAt: 'desc' },
        take: fetchLimit,
        select: { id: true, kind: true, metadata: true, severity: true, createdAt: true } })),
      // login events live in activity_events (kind: auth.login_* / auth.log:*).
      trackQuery('login_history_by_user_created', () => prisma.activityEvent.findMany({
        where: { userId: session.userId, kind: { contains: 'login' } },
        orderBy: { createdAt: 'desc' },
        take: fetchLimit,
        select: { id: true, kind: true, ipAddress: true, userAgent: true, metadata: true, createdAt: true } })),
      // Run all 3 count queries in parallel inside a single Promise.all
      Promise.all([
        trackQuery('activity_total_count', () => prisma.activityEvent.count({ where: { userId: session.userId } })),
        trackQuery('activity_total_security', () => prisma.activityEvent.count({ where: { userId: session.userId, kind: { startsWith: 'security.' } } })),
        trackQuery('activity_total_login', () => prisma.activityEvent.count({ where: { userId: session.userId, kind: { contains: 'login' } } })),
      ]),
    ]);

    // Merge into a single flat array sorted by date — dashboard expects this format
    const merged = [
      ...auditEvents.map(e => ({
        id: e.id, ref: eventRowRef(e), source: 'audit', action: e.kind, targetType: (e.metadata as any)?.targetType ?? null,
        targetId: e.detail, metadata: e.metadata, severity: e.severity,
        createdAt: e.createdAt })),
      ...securityEvents.map(e => ({
        id: e.id, ref: eventRowRef(e), source: 'security', action: e.kind, targetType: null as string | null,
        targetId: null as string | null, metadata: e.metadata, severity: e.severity,
        createdAt: e.createdAt })),
      ...loginHistoryRecords.map(e => ({
        id: e.id, ref: eventRowRef(e), source: 'login', action: e.kind,
        targetType: 'session' as string | null, targetId: null as string | null,
        metadata: { ...((e.metadata as Record<string, any>) || {}), ip: e.ipAddress, userAgent: e.userAgent },
        severity: (String(e.kind).includes('failed') ? ('warning' as const) : ('info' as const)),
        createdAt: e.createdAt })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(offset, offset + limit);
    const total = (totalCounts as number[]).reduce((a, b) => a + b, 0);
    const payload = { events: merged, total };
    activityCache.set(cacheKey, payload);
    return NextResponse.json(payload);
  } catch (err: any) {
    console.error('[USER ACTIVITY]', err?.message || err);
    return NextResponse.json({ events: [], total: 0 });
  }
}

/**
 * GET /api/user/activity/daily — the counted shape of the account's history.
 *
 * The "Your activity" screen draws a day-per-bar picture, and the only honest
 * days it can draw are the ones the account itself recorded: rows in
 * activity.activity_events (what changed) and security.user_logins (every time
 * someone got in). Both are grouped here by day, in the caller's own timezone,
 * because "a day" means the day on the reader's clock rather than the server's.
 *
 * Deliberately raw counts and kind names, with no grouping, labelling or
 * averaging: what the kinds add up to is display, and the app reading this owns
 * it. Nothing here is measured, estimated or extrapolated — a day with no rows
 * is a day the account has no record of.
 */
export async function userDailyActivityHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const sp = request.nextUrl.searchParams;
    const days = Math.min(Math.max(parseInt(sp.get('days') || '30', 10) || 30, 1), 90);
    const tz = sp.get('tz') || 'UTC';
    // The timezone name is bound as a parameter, but a value that isn't shaped
    // like one is refused outright rather than handed to Postgres to judge.
    if (!/^[A-Za-z_]+(?:\/[A-Za-z_+-]{1,40}){0,2}$/.test(tz)) {
      return NextResponse.json({ error: 'Unrecognised timezone' }, { status: 400 });
    }
    // Right shape is not the same as a zone that exists — Postgres would raise
    // on 'Nonexistent/Zone' and this screen would report a server fault for
    // what is really a bad query string.
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    } catch {
      return NextResponse.json({ error: 'Unrecognised timezone' }, { status: 400 });
    }
    const since = new Date(Date.now() - days * 86_400_000);

    const [events, signIns] = await Promise.all([
      prisma.$queryRaw<{ day: string; kind: string; count: number }[]>`
        select to_char(created_at at time zone ${tz}::text, 'YYYY-MM-DD') as day,
               kind, count(*)::int as count
        from "public".activity_events
        where user_id = ${session.userId} and created_at >= ${since}
        group by 1, 2
        order by 1`,
      prisma.$queryRaw<{ day: string; kind: string; count: number }[]>`
        select to_char(created_at at time zone ${tz}::text, 'YYYY-MM-DD') as day,
               method as kind, count(*)::int as count
        from "public".user_logins
        where user_id = ${session.userId} and created_at >= ${since} and success = true
        group by 1, 2
        order by 1`,
    ]);

    return NextResponse.json({ days, tz, since: since.toISOString(), events, signIns });
  } catch (err: any) {
    console.error('[USER DAILY ACTIVITY]', err?.message || err);
    return NextResponse.json({ error: 'Failed to read activity' }, { status: 500 });
  }
}

/** The ledger kinds that record the owner having *asked* for something —
 *  each row was written by the action it names. A message to staff
 *  (support.request) and the answer back (support.reply) belong here too: a
 *  request is not an edit to the account, so it lives on the request record,
 *  not in the change log. */
const REQUEST_EVENT_KINDS = [
  'account.deactivated',
  'account.reactivated',
  'account.delete-code',
  'account.delete-request',
  'account.deletion-cancelled',
  'security.deletion_scheduled',
  'security.deletion_cancelled',
  'appeal.filed',
  'account.merge',
  'support.request',
  'support.reply',
];

/**
 * GET /api/user/requests — every request the account has made, one list.
 *
 * The "Requests and history" screen used to show only what is in force now;
 * this is the ledger behind it — downloads asked for, codes mailed, pauses,
 * closings, appeals, and messages to staff — merged from the two places
 * requests are actually kept: the activity rows the actions write, and the
 * export table (which carries a status the activity row doesn't). Newest
 * first, capped, read-only.
 *
 * A support thread is the one kind that arrives in pairs — the question and
 * the answer — so each is folded into one row under the reference code both
 * mails quote. That code, not the row id, is the handle the account sees.
 */
export async function userRequestsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 100);

    const [events, exports] = await Promise.all([
      prisma.activityEvent.findMany({
        where: { userId: session.userId, kind: { in: REQUEST_EVENT_KINDS } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, kind: true, title: true, detail: true, metadata: true, createdAt: true },
      }),
      prisma.dataExportRequest.findMany({
        where: { userId: session.userId },
        orderBy: { requestedAt: 'desc' },
        take: limit,
        select: { id: true, format: true, status: true, fileName: true, requestedAt: true },
      }),
    ]);

    /* Whether a message to staff has an answer yet is decided from the ledger
       itself, not a flag on the request: a support.reply under the same
       reference is the answer. One thread reads as one row — the question,
       marked answered, quoting the answer — because two rows for one
       conversation is how a person ends up re-asking something that was
       already replied to. */
    const refOf = (metadata: unknown, id: string): string => {
      const code = (metadata as Record<string, any> | null)?.refCode;
      return (typeof code === 'string' && code.trim()) ? code.trim() : (refFromRowId(id) ?? id);
    };
    /** The newest answer per reference, so an answered thread says when. */
    const answers = new Map<string, { at: string; detail: string | null; title: string; text: string | null }>();
    for (const e of events) {
      if (e.kind !== 'support.reply') continue;
      const code = refOf(e.metadata, e.id);
      const meta = (e.metadata || {}) as Record<string, any>;
      const found = {
        at: e.createdAt.toISOString(),
        detail: e.detail ?? null,
        title: e.title,
        // The words, not the row's summary line: an answer that reads "Answered
        // xxxx by mail" tells the person nothing they did not already know.
        text: typeof meta.message === 'string' && meta.message ? meta.message : null,
      };
      if (!answers.has(code) || found.at > (answers.get(code) as { at: string }).at) answers.set(code, found);
    }
    /** Which references have their question on this page. A reply whose
        request is here rides inside that row; a reply whose request fell out
        of the window stays a row of its own, so no answer is ever dropped. */
    const asked = new Set(
      events.filter((e) => e.kind === 'support.request').map((e) => refOf(e.metadata, e.id)));

    const requests = [
      ...events
        .filter((e) => !(e.kind === 'support.reply' && asked.has(refOf(e.metadata, e.id))))
        .map((e) => {
          const meta = (e.metadata || {}) as Record<string, any>;
          const ref = refOf(e.metadata, e.id);
          const answer = e.kind === 'support.request' ? (answers.get(ref) ?? null) : null;
          const status = e.kind === 'support.request'
            ? (answer ? 'answered' : 'open')
            : e.kind === 'support.reply' ? 'answered' : null;
          return {
            id: e.id, kind: e.kind, ref, title: e.title, detail: e.detail ?? null,
            status,
            answeredAt: answer?.at ?? (e.kind === 'support.reply' ? e.createdAt.toISOString() : null),
            answer: answer
              ? { at: answer.at, detail: answer.detail, title: answer.title, text: answer.text }
              : null,
            at: e.createdAt.toISOString(),
            subject: typeof meta.subject === 'string' ? meta.subject : null,
          };
        }),
      ...exports.map((e) => ({
        id: e.id, kind: 'data.download', ref: refFromRowId(e.id) ?? e.id,
        title: e.format === 'html' ? 'Data download (readable copy)' : 'Data download (JSON)',
        detail: e.fileName, status: e.status, answeredAt: null, at: e.requestedAt.toISOString(),
      })),
    ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);

    return NextResponse.json({ requests });
  } catch (err: any) {
    console.error('[USER REQUESTS]', err?.message || err);
    return NextResponse.json({ requests: [] });
  }
}

// ═══════════════════════════════════════════════════════════════════
// USER CHANGE HISTORY — the account's own record of what it edited
// ═══════════════════════════════════════════════════════════════════

/** The owner's answer to "was this you", written as an event of its own.
    Storing the answer in the same ledger it is about means it survives the
    device it was given on, is dated by the server, and can't be quietly
    edited afterwards — which is the only reason an answer is worth keeping.
    The store itself lives in features/users/change-answers.ts so the security
    feature can read the answers without importing this file. */
const CHANGE_ANSWER_KIND = ANSWER_KIND;

/** Sign-ins have their own page, and a bot check or a device sighting is not
    something anyone edited. A message to staff is not an edit either — it is a
    request, and it belongs on the account's own request record, where reading
    it says "you asked us this", not "you changed this field". Everything the
    account *did* stays. */
const NOT_A_CHANGE = {
  NOT: [
    { kind: { startsWith: 'auth.' } },
    { kind: { startsWith: 'request.' } },
    { kind: { startsWith: 'device.' } },
    { kind: { startsWith: 'support.' } },
    { kind: { contains: 'login' } },
    { kind: { contains: 'logout' } },
    { kind: CHANGE_ANSWER_KIND },
  ] };

/** The same row a list would show, by id — or nothing. The answer records are
    kept out of the list by NOT_A_CHANGE, but a page that asks for one by its
    id would still be handed it; this is the one place both single-row handlers
    go through, so hiding them isn't something each has to remember. */
async function findOwnedChange(userId: string, changeId: string) {
  return prisma.activityEvent.findFirst({
    where: { id: changeId, userId, ...NOT_A_CHANGE },
    select: { id: true, kind: true, title: true, detail: true, severity: true, ipAddress: true, userAgent: true, metadata: true, createdAt: true } });
}

/** One activity row, said the way the change log reads it. Both the list and
    the single-change page go through here, so the two can't drift. */
function changeView(
  row: {
    id: string;
    kind: string;
    title: string;
    detail: string | null;
    severity: string;
    ipAddress: string | null;
    userAgent: string | null;
    metadata: unknown;
    createdAt: Date;
  },
  said: { answer: string; at: string } | null,
) {
  const meta = (row.metadata || {}) as Record<string, any>;
  return {
    id: row.id,
    /* The reference a person quotes to support and staff paste into admin.
       Written at create time into metadata.refCode; rows older than that
       resolve to the code derived from their own id, so every row has always
       had exactly one — including the ones predating the stamp. */
    ref: typeof meta.refCode === 'string' && meta.refCode.trim()
      ? meta.refCode.trim()
      : (refFromRowId(row.id) ?? row.id),
    kind: row.kind,
    /* Rows written before the ledger humanised its own titles carry the
       machine key in the title column. Reading them through the same function
       the writers use means the history page is literate all the way down,
       not only from today. */
    title: row.title && row.title !== row.kind ? row.title : humanTitle(row.kind),
    /** Which fields the change touched — the log's own words for it. A row's
        `detail` is often a record reference ("user:…"), which is a pointer, not
        a field name, so it is never shown as one. */
    fields: Array.isArray(meta.fields)
      ? meta.fields.filter((f: unknown) => typeof f === 'string' && !/^[a-z_]+[:-][\w-]+$/i.test(f))
      : (row.detail && !/^[a-z_]+[:-][\w-]+$/i.test(row.detail) ? [row.detail] : []),
    severity: row.severity,
    at: row.createdAt.toISOString(),
    ip: row.ipAddress,
    device: describeDevice(row.userAgent),
    location: typeof meta.location === 'string' ? meta.location : null,
    /* The pin the change's own page draws. Present only when the edge resolved
       the address to a point — a place with no coordinates shows its words. */
    coords: Array.isArray(meta.coords) && meta.coords.length === 2
      && typeof meta.coords[0] === 'number' && typeof meta.coords[1] === 'number'
      ? [meta.coords[0], meta.coords[1]] as [number, number]
      : null,
    said };
}

/** The newest answer given about each change. Lives in
    features/users/change-answers.ts — the sign-in ledger reads it too. */

/**
 * GET /api/user/changes — every change this account recorded, newest first,
 * with the owner's answer to "was this you" folded in.
 *
 * The rows are activity.activity_events for this user and this user only.
 * What a change *moved to* is deliberately absent: the account records that
 * the email or the privacy setting changed, on which machine, from which
 * address, at which instant — not the old value and the new one side by side.
 * Reading a change log means knowing what it can tell you, so the reply says
 * `fields` (which names were touched) rather than inventing before/after.
 */
export async function userChangesHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const sp = request.nextUrl.searchParams;
    const limit = Math.min(Math.max(parseInt(sp.get('limit') || '50', 10) || 50, 1), 200);

    const [rows, said] = await Promise.all([
      prisma.activityEvent.findMany({
        where: { userId: session.userId, ...NOT_A_CHANGE },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, kind: true, title: true, detail: true, severity: true, ipAddress: true, userAgent: true, metadata: true, createdAt: true } }),
      answerIndex(session.userId),
    ]);

    const changes = rows.map((row) => changeView(row, said.get(row.id) ?? null));

    return NextResponse.json({ changes, total: changes.length });
  } catch (err: any) {
    console.error('[USER CHANGES]', err?.message || err);
    return NextResponse.json({ error: 'Failed to read the change history' }, { status: 500 });
  }
}

/**
 * GET /api/user/changes/:id — one change, for the page that shows nothing
 * but it. Scoped to the caller, so someone else's id reads as "not in your
 * history" rather than as a record with its fields exposed.
 */
export async function userChangeDetailHandler(request: NextRequest, changeId: string) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const row = await findOwnedChange(session.userId, changeId);
    if (!row) return NextResponse.json({ error: 'That change is not in your history' }, { status: 404 });

    const said = await answerIndex(session.userId);
    return NextResponse.json({ change: changeView(row, said.get(changeId) ?? null) });
  } catch (err: any) {
    console.error('[USER CHANGE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to read the change' }, { status: 500 });
  }
}

/**
 * POST /api/user/changes/:id/answer — "this was me" / "that wasn't me".
 *
 * The row has to belong to the account answering, which is what the lookup is
 * for: an id from someone else's history is a 404, not a write. Two kinds of
 * row can be answered:
 *
 *   • a CHANGE — an activity_events row (the password changed, two-factor
 *     turned on), addressed by its own id;
 *   • a SIGN-IN — a user_logins row, addressed by its own id. The sign-in
 *     ledger has no review column, so before this the answer to a sign-in was
 *     kept on the phone that gave it and went nowhere else. The answer store
 *     is keyed by the row it is about, so the ledger reads it back — the
 *     answer follows the account instead of the device.
 *
 * Clearing an answer writes another row rather than deleting one, so the
 * ledger shows that the answer changed, not that it never existed.
 *
 * "That wasn't me" is a report, not a note: the account owner is told (in-app
 * and by mail — it is a security answer, so it is never held back by the
 * notification toggles) and the admins are alerted, because a stranger on the
 * account is exactly what a human should look at.
 */
export async function changeAnswerHandler(request: NextRequest, changeId: string) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body: any = await request.json().catch(() => null);
    const answer = body?.answer as ChangeAnswerValue;
    if (answer !== 'recognised' && answer !== 'not-me' && answer !== null) {
      return NextResponse.json({ error: 'Say either "recognised", "not-me", or null to clear it' }, { status: 400 });
    }

    const owned = await findOwnedChange(session.userId, changeId);
    const signIn = owned
      ? null
      : await prisma.userLogin.findFirst({
          where: { id: changeId, userId: session.userId },
          select: { id: true, ipAddress: true, userAgent: true, method: true, location: true, success: true, createdAt: true },
        });
    if (!owned && !signIn) return NextResponse.json({ error: 'That change is not in your history' }, { status: 404 });

    await logSecurityEvent({
      request,
      userId: session.userId,
      eventType: CHANGE_ANSWER_KIND,
      severity: answer === 'not-me' ? 'warning' : 'info',
      details: { about: changeId, answer, aboutKind: owned ? 'change' : 'signin' } });

    if (answer === 'not-me') {
      await reportDisputedRow({
        request,
        userId: session.userId,
        email: session.email || null,
        rowId: changeId,
        kind: owned ? 'change' : 'signin',
        about: owned ?? signIn,
      });
    }

    return NextResponse.json({ ok: true, id: changeId, answer, answeredAt: new Date().toISOString() });
  } catch (err: any) {
    console.error('[CHANGE ANSWER]', err?.message || err);
    return NextResponse.json({ error: 'Failed to record the answer' }, { status: 500 });
  }
}

/**
 * "That wasn't me" — the account says a row was not them.
 *
 * Two audiences, and neither of them is the browser that pressed the button:
 *
 *   • THE OWNER — the person who pressed it already knows; what they need is
 *     the account's own answer to it: a notification that says the report is
 *     in, what to do next (change the password, end the other sessions), and
 *     where the record is. It is a security answer, so it is written as one:
 *     in-app always, and by mail whatever the notification toggles say.
 *
 *   • THE ADMINS — a stranger on someone's account is the one thing a human
 *     should look at. They get the alert with the row's own facts: when, from
 *     where, on what, and the reference code to quote.
 *
 * Both are best-effort: a failure to alert is a failure to tell, not a reason
 * to refuse the answer the account gave. The answer itself is already written.
 */
async function reportDisputedRow(input: {
  request: NextRequest;
  userId: string;
  email: string | null;
  rowId: string;
  kind: 'change' | 'signin';
  /** The row being disputed, from whichever ledger holds it. Everything an
      investigator needs is on it: where it came from, when, and what it was. */
  about: {
    ipAddress?: string | null;
    userAgent?: string | null;
    location?: string | null;
    method?: string | null;
    title?: string | null;
    createdAt?: Date | null;
  } | null;
}) {
  const { userId, rowId, kind, about } = input;
  const ip = about?.ipAddress || null;
  const device = deviceDetail(about?.userAgent || null);
  const location = about?.location || null;
  const when = (about?.createdAt || new Date()).toISOString();
  // What the row actually was, not the kind of ledger it lives in. "Kind:
  // account change" told an admin nothing; "Updated your profile" tells them
  // which event to go and read.
  const what = about?.title
    || (kind === 'signin'
      ? `Signed in${about?.method ? ` with ${about.method.charAt(0).toUpperCase()}${about.method.slice(1)}` : ''}`
      : 'An account change');

  // The handle a person can quote. A row id is a query parameter, not a fact
  // about an event, and it is the code the owner's own mail already shows — the
  // two must match or the thread cannot be joined.
  const ref = refFromRowId(rowId) ?? rowId;

  // Only the facts that exist. A line reading "Address: unknown" is not an
  // absence of information, it is a claim that the address is the word
  // "unknown" — and it pushes the two lines that matter off the screen.
  const details = [
    `Account: ${input.email || userId}`,
    `What: ${what}`,
    `When: ${when}`,
    device ? `Device: ${device}` : '',
    location ? `Location: ${location}` : '',
    ip ? `Address: ${ip}` : '',
    `Owner said: "that wasn't me"`,
  ].filter(Boolean).join('\n');

  // The admins first — it is the one that has a human waiting. The disputed
  // row's own code leads the alert, because that is the code the owner was
  // shown and the one the two of them will be quoting at each other.
  await notifyAdmins({
    subject: 'Account holder disputed a sign-in',
    message: 'The owner of an account marked a row as "that wasn\'t me".',
    details,
    refCode: ref,
    severity: 'warning',
  }).catch(() => {});

  // Then the owner, in their own inbox.
  await createNotification({
    userId,
    type: 'security',
    title: 'You told us a sign-in wasn\'t you',
    body: 'We have marked that record and told the team. Change your password and end the sessions you don\'t recognise.',
    link: '/settings/login-activity',
    metadata: { about: rowId, kind, ip, device, location, when, ref },
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════
// USER APPS HANDLER — DB-backed across the Tirbeo suite
// ═══════════════════════════════════════════════════════════════════
const APPS_CACHE = createTtlCache<any>(10_000, 2000, 'apps');

export async function userAppsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const userId = session.userId;

    const [
      unreadNotifications,
      activeSessions,
      integrations,
    ] = await Promise.all([
      trackQuery('apps_notif_unread', () => prisma.notification.count({ where: { userId, isRead: false } })),
      trackQuery('apps_sessions_active', () => prisma.userSession.count({ where: { userId, status: 'active' } })),
      trackQuery('apps_integrations', () => prisma.userPreferences.findUnique({
        where: { userId },
        select: { misc: true } })),
    ]);

    const formCount = 0;
    const openTickets = 0;
    const storageBytes = 0;
    const oauthLinks = ((integrations as any)?.misc?.oauth ?? {}) as Record<string, string>;
    const connectedIntegrations = ['google', 'github', 'discord'].filter((p) => !!oauthLinks[p]).length;

    const formsUrl = process.env.NEXT_PUBLIC_FORMS_URL || 'https://forms.tirbeo.com';
    const apps = [
      {
        id: 'forms', name: 'Forms', title: 'Forms', subtitle: 'Forms & Surveys', index: '01',
        gradient: 'linear-gradient(135deg, #38bdf8 0%, #6366f1 100%)', blob1: '#7dd3fc', blob2: '#818cf8',
        live: true, href: formsUrl, count: formCount, connected: false },
      {
        id: 'collab', name: 'Collab', title: 'Collab', subtitle: 'Social Network', index: '02',
        gradient: 'linear-gradient(135deg, #f97316 0%, #ec4899 60%, #8b5cf6 100%)', blob1: '#fb923c', blob2: '#f472b6',
        live: false, href: null, count: 0, connected: false },
    ];

    const payload = {
      apps,
      stats: {
        forms: formCount,
        openTickets,
        unreadNotifications,
        activeSessions,
        storageBytes,
        storageLabel: storageBytes > 0
          ? `${(storageBytes / (1024 * 1024 * 1024)).toFixed(storageBytes >= 1024 ** 3 ? 1 : 2)} GB`
          : '0 GB',
        connectedIntegrations } };
    APPS_CACHE.set(userId, payload);
    return NextResponse.json(payload);
  } catch (err: any) {
    console.error('[USER APPS]', err?.message || err);
    return NextResponse.json({ apps: [], stats: { forms: 0, openTickets: 0, unreadNotifications: 0, activeSessions: 0, storageBytes: 0, storageLabel: '0 GB', connectedIntegrations: 0 } });
  }
}

// ═══════════════════════════════════════════════════════════════════
// USER OVERVIEW HANDLER — DB-backed home dashboard summary
// ═══════════════════════════════════════════════════════════════════
export async function userOverviewHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const userId = session.userId;

    const [
      user,
      unreadNotifications,
      activeSessions,
      recentAudit,
      recentSecurity,
      recentLogin,
    ] = await Promise.all([
      trackQuery('overview_user', () => prisma.user.findUnique({ where: { id: userId } })),
      trackQuery('overview_notif_unread', () => prisma.notification.count({ where: { userId, isRead: false } })),
      trackQuery('overview_sessions_active', () => prisma.userSession.count({ where: { userId, status: 'active' } })),
      trackQuery('overview_recent_audit', () => prisma.activityEvent.findMany({
        where: { userId: userId }, orderBy: { createdAt: 'desc' }, take: 6,
        select: { id: true, kind: true, detail: true, metadata: true, severity: true, createdAt: true } })),
      trackQuery('overview_recent_security', () => prisma.activityEvent.findMany({
        where: { userId, kind: { startsWith: 'security.' } }, orderBy: { createdAt: 'desc' }, take: 6,
        select: { id: true, kind: true, metadata: true, severity: true, createdAt: true } })),
      trackQuery('overview_recent_login', () => prisma.activityEvent.findMany({
        where: { userId, kind: { contains: 'login' } }, orderBy: { createdAt: 'desc' }, take: 6,
        select: { id: true, kind: true, ipAddress: true, userAgent: true, metadata: true, createdAt: true } })),
    ]);

    const recentActivity = [
      ...recentAudit.map((e) => ({
        id: e.id, source: 'audit', action: e.kind, targetType: (e.metadata as any)?.targetType ?? null,
        targetId: e.detail, metadata: e.metadata, severity: e.severity, createdAt: e.createdAt })),
      ...recentSecurity.map((e) => ({
        id: e.id, source: 'security', action: e.kind, targetType: null as string | null,
        targetId: null as string | null, metadata: e.metadata, severity: e.severity, createdAt: e.createdAt })),
      ...recentLogin.map((e) => ({
        id: e.id, source: 'login', action: e.kind,
        targetType: 'session' as string | null, targetId: null as string | null,
        metadata: { ...((e.metadata as Record<string, any>) || {}), ip: e.ipAddress, userAgent: e.userAgent },
        severity: (String(e.kind).includes('failed') ? ('warning' as const) : ('info' as const)),
        createdAt: e.createdAt })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 6);

    const storageBytes = 0;

    return NextResponse.json({
      overview: {
        unreadNotifications,
        openTickets: 0,
        activeSessions,
        formsCount: 0,
        storageBytes,
        storageLabel: storageBytes >= 1024 ** 3
          ? `${(storageBytes / 1024 ** 3).toFixed(1)} GB`
          : `${(storageBytes / 1024 ** 2).toFixed(1)} MB`,
        loginCount: (user as any)?.loginCount ?? 0,
        memberSince: (user as any)?.createdAt ?? null,
        lastActiveAt: (user as any)?.lastActiveAt ?? null },
      recentActivity });
  } catch (err: any) {
    console.error('[USER OVERVIEW]', err?.message || err);
    return NextResponse.json({ overview: { unreadNotifications: 0, openTickets: 0, activeSessions: 0, formsCount: 0, storageBytes: 0, storageLabel: '0 MB', loginCount: 0, memberSince: null, lastActiveAt: null }, recentActivity: [] });
  }
}

// ═══════════════════════════════════════════════════════════════════
// PREFERENCES HANDLER
// ═══════════════════════════════════════════════════════════════════
export async function preferencesHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const cacheKey = PREFS_CACHE_KEY(session.userId);
    if (request.method === 'GET') {
      const cached = preferencesCache.get(cacheKey);
      if (cached) return NextResponse.json(cached);
    }

    // user_preferences is the single source of truth: theme/language/timezone in
    // `appearance`, and the consent switches in `misc.consents` (where the old
    // users.consents column moved to).
    //
    // There is no separate "does this account exist" read first: a session only
    // exists while its account does (`user_sessions.user` cascades on delete), so
    // the lookup below answers the same question for free.
    const prefsRow = await prisma.userPreferences.findUnique({
      where: { userId: session.userId },
      select: { appearance: true, privacy: true, misc: true } });
    const appearance = (prefsRow?.appearance && typeof prefsRow.appearance === 'object' ? prefsRow.appearance : {}) as Record<string, any>;
    const privacy = (prefsRow?.privacy && typeof prefsRow.privacy === 'object' ? prefsRow.privacy : {}) as Record<string, any>;
    const misc = (prefsRow?.misc && typeof prefsRow.misc === 'object' ? prefsRow.misc : {}) as Record<string, any>;
    const miscConsents = (misc.consents && typeof misc.consents === 'object' ? misc.consents : {}) as Record<string, any>;
    const currentPrivacy = {
      allowAnalytics: privacy.allowAnalytics ?? miscConsents.allowAnalytics ?? false,
      allowCrashReports: privacy.allowCrashReports ?? miscConsents.allowCrashReports ?? true };

    if (request.method === 'GET') {
      const payload = {
        ok: true,
        preferences: {
          theme: appearance.theme ?? 'system',
          language: appearance.language ?? 'en',
          timezone: appearance.timezone ?? 'UTC',
          privacy: currentPrivacy } };
      preferencesCache.set(cacheKey, payload);
      return NextResponse.json(payload);
    }

    if (request.method === 'PATCH' || request.method === 'PUT') {
      const body: any = await request.json().catch(() => ({}));

      const nextAppearance = { ...appearance };
      let appearanceChanged = false;
      for (const key of ['theme', 'language', 'timezone', 'dateFormat', 'timeFormat'] as const) {
        if (body[key] !== undefined) { nextAppearance[key] = body[key]; appearanceChanged = true; }
      }

      const nextPrivacy = { ...privacy };
      let privacyChanged = false;
      if (body.privacy && typeof body.privacy === 'object') {
        if (typeof body.privacy.allowAnalytics === 'boolean') { nextPrivacy.allowAnalytics = body.privacy.allowAnalytics; privacyChanged = true; }
        if (typeof body.privacy.allowCrashReports === 'boolean') { nextPrivacy.allowCrashReports = body.privacy.allowCrashReports; privacyChanged = true; }
      }

      // The consent switches are canonically stored in misc.consents (what
      // features/users/consent.ts reads); mirror them there on every change so
      // the store stays the one answer.
      const nextMisc = privacyChanged
        ? { ...misc, consents: { ...miscConsents, ...nextPrivacy, updatedAt: new Date().toISOString() } }
        : null;

      if (appearanceChanged || privacyChanged) {
        await prisma.userPreferences.upsert({
          where: { userId: session.userId },
          create: {
            userId: session.userId,
            appearance: nextAppearance as any,
            privacy: nextPrivacy as any,
            ...(nextMisc ? { misc: nextMisc as any } : {}) },
          update: {
            ...(appearanceChanged ? { appearance: nextAppearance as any } : {}),
            ...(privacyChanged ? { privacy: nextPrivacy as any } : {}),
            ...(nextMisc ? { misc: nextMisc as any } : {}) } });
        bustPreferencesCache(session.userId);
      }

      // Record consent changes in the audit log with full details.
      if (privacyChanged) {
        prisma.activityEvent.create({
          data: {
            userId: session.userId,
            kind: 'consent.updated',
            title: 'Consent updated',
            detail: session.userId,
            metadata: {
              targetType: 'user',
              privacy: body.privacy,
              previous: currentPrivacy,
              changedAt: new Date().toISOString(),
              changedFields: Object.keys(body.privacy).filter(k => typeof body.privacy[k] === 'boolean') },
            severity: 'info',
            ipAddress: (request as any)?.headers?.get?.('x-forwarded-for')?.split(',')[0]?.trim() || (request as any)?.headers?.get?.('x-real-ip') || null,
            userAgent: (request as any)?.headers?.get?.('user-agent')?.slice(0, 200) || null } }).catch(() => {});
      }

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[PREFERENCES]', err?.message || err);
    return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// GENERIC USER SETTINGS
// A named bag of small JSON choices (theme, language, notification picks,
// data-permissions, download defaults …) that the settings screens used to
// keep in this browser only. One row per user, keyed map under
// preferences.user_preferences.misc.settings, so a page can read the whole
// bag once and merge-write just the key it changed. Structured choices that
// other services read (theme/language/timezone/privacy) keep their own
// semantic columns via /api/preferences — this bag is for the rest.
//
// The bounds live in features/users/settingsBag.ts: the bag is not whitelisted
// (a dropped key is a lost piece of somebody's saved state), it is measured.
// ═══════════════════════════════════════════════════════════════════
export async function settingsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    if (request.method === 'GET') {
      const [row, sec] = await Promise.all([
        prisma.userPreferences.findUnique({
          where: { userId: session.userId },
          select: { misc: true } }),
        prisma.userSecurity.findUnique({
          where: { userId: session.userId },
          select: { saveLoginInfo: true, require2FA: true, totpEnabled: true } }),
      ]);
      const misc = (row?.misc && typeof row.misc === 'object' ? row.misc : {}) as Record<string, any>;
      const require2FA = !!(sec?.require2FA && sec?.totpEnabled);
      return NextResponse.json({
        ok: true,
        settings: {
          ...(misc.settings ?? {}),
          saveLoginInfo: sec?.saveLoginInfo ?? true,
          require2FA,
          twoFactorRequireForActions: require2FA } });
    }

    if (request.method === 'PATCH' || request.method === 'PUT') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const incoming = (body && typeof body.settings === 'object' ? body.settings : body) as Record<string, unknown>;

      // saveLoginInfo / require2FA are account policy columns, not bag keys —
      // they outlive this browser and other services read them at auth time.
      const policy: Record<string, boolean> = {};
      if (typeof incoming?.saveLoginInfo === 'boolean') policy.saveLoginInfo = incoming.saveLoginInfo;
      const requireVal = typeof incoming?.require2FA === 'boolean'
        ? incoming.require2FA
        : typeof incoming?.twoFactorRequireForActions === 'boolean'
          ? incoming.twoFactorRequireForActions
          : undefined;
      if (requireVal !== undefined) {
        // The UI toggle is not the guard: without an enrolled TOTP, requiring
        // a second factor would lock the account out of signing in.
        if (requireVal) {
          const cur = await prisma.userSecurity.findUnique({
            where: { userId: session.userId },
            select: { totpEnabled: true } });
          if (!cur?.totpEnabled) {
            return NextResponse.json({ error: 'Turn on two-factor authentication before requiring it.' }, { status: 400 });
          }
        }
        policy.require2FA = requireVal;
      }
      if (Object.keys(policy).length > 0) {
        await prisma.userSecurity.upsert({
          where: { userId: session.userId },
          create: { userId: session.userId, ...policy },
          update: policy });
        // Flipping save-login OFF takes effect immediately: every OTHER
        // long-lived session dies, this one survives on the 1h idle deadline
        // (keeps the current session, like the existing revoke-all endpoint).
        if (policy.saveLoginInfo === false) {
          await revokeLongLivedSessions(session.userId, session.sessionId);
        }
        for (const k of ['saveLoginInfo', 'require2FA', 'twoFactorRequireForActions']) delete incoming[k];
      }

      const rejectedKey = Object.keys(incoming ?? {}).find((k) => FORBIDDEN_SETTINGS_KEYS.has(k));
      if (rejectedKey) {
        return NextResponse.json(
          { error: `Not a valid setting name: ${rejectedKey}`, code: 'INVALID_SETTINGS_KEY' },
          { status: 400 });
      }
      const tooLongKey = Object.keys(incoming ?? {}).find((k) => k.length > SETTINGS_LIMITS.keyBytes);
      if (tooLongKey) {
        return NextResponse.json(
          { error: `Setting names are limited to ${SETTINGS_LIMITS.keyBytes} characters`, code: 'SETTINGS_KEY_TOO_LONG' },
          { status: 400 });
      }
      if (containsForbiddenSettingsKey(incoming)) {
        return NextResponse.json(
          { error: 'Settings values may not contain reserved keys', code: 'INVALID_SETTINGS_KEY' },
          { status: 400 });
      }

      // Values that are not JSON (functions, symbols, NaN, over-deep nesting)
      // are dropped, not stored: they would vanish on the read anyway, and a
      // half-stored value that changes shape between write and read is worse
      // than a named, logged omission.
      const ignoredKeys: string[] = [];
      for (const key of Object.keys(incoming ?? {})) {
        const value = (incoming as Record<string, unknown>)[key];
        if (!isStorableSettingsValue(value)) {
          ignoredKeys.push(key);
          delete (incoming as Record<string, unknown>)[key];
          continue;
        }
        let valueBytes = 0;
        try { valueBytes = JSON.stringify(value)?.length ?? 0; } catch { valueBytes = Number.POSITIVE_INFINITY; }
        if (valueBytes > SETTINGS_LIMITS.valueBytes) {
          return NextResponse.json(
            {
              error: `One setting is too large to store (limit ${SETTINGS_LIMITS.valueBytes} characters).`,
              code: 'SETTINGS_VALUE_TOO_LARGE',
              key,
              limitBytes: SETTINGS_LIMITS.valueBytes,
              actualBytes: Number.isFinite(valueBytes) ? valueBytes : null,
            },
            { status: 413 });
        }
      }
      if (ignoredKeys.length) {
        console.warn(`[SETTINGS] ignored non-JSON values for ${session.userId}: ${ignoredKeys.join(', ')}`);
      }

      const keys = Object.keys(incoming ?? {});

      // The change ledger answers "what changed?" — so every accepted write
      // files one row naming the settings it moved, whatever shape the bag
      // came in under. Values are deliberately not recorded, only the names.
      const FIELD_LABELS: Record<string, string> = {
        twoFactorRequireForActions: 'two-factor for sensitive actions',
        twoFactorAlertSuspicious: 'suspicious sign-in alerts',
        saveLoginInfo: 'saved login info',
      };
      const changedFields = [
        ...(policy.saveLoginInfo !== undefined ? [FIELD_LABELS.saveLoginInfo] : []),
        ...(policy.require2FA !== undefined ? [FIELD_LABELS.twoFactorRequireForActions] : []),
        ...keys.map((k) => FIELD_LABELS[k] ?? k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()),
      ];

      if (keys.length === 0) {
        if (changedFields.length) {
          await createAuditEvent({
            actorId: session.userId,
            action: 'settings.updated',
            targetType: 'user',
            targetId: session.userId,
            metadata: { fields: changedFields } }).catch(() => {});
        }
        return NextResponse.json({ ok: true, settings: { ...policy } });
      }

      // Read, merge, validate, write as one serialized pass: the whole misc
      // column is rewritten per save, and two overlapping settings changes
      // used to silently drop one of them.
      const outcome = await serializedPrefsWrite(async (tx) => {
        const row = await tx.userPreferences.findUnique({
          where: { userId: session.userId },
          select: { misc: true } });
        const misc = (row?.misc && typeof row.misc === 'object' ? row.misc : {}) as Record<string, any>;
        const settings = { ...(misc.settings ?? {}) } as Record<string, unknown>;
        for (const key of keys) settings[key] = incoming[key];

        // The bound that matters is the MERGED bag, not this request: a client
        // that sends 1 KB at a time can otherwise grow the row forever.
        const bagBytes = settingsBagBytes(settings);
        if (bagBytes === null) return { kind: 'invalid' as const, settings: null };
        if (bagBytes > SETTINGS_LIMITS.totalBytes) return { kind: 'too-large' as const, settings: null, bagBytes };

        const nextMisc = { ...misc, settings };
        await tx.userPreferences.upsert({
          where: { userId: session.userId },
          create: { userId: session.userId, misc: nextMisc as any },
          update: { misc: nextMisc as any } });
        return { kind: 'saved' as const, settings };
      });

      if (outcome.kind === 'invalid') {
        return NextResponse.json(
          { error: 'These settings could not be stored as saved.', code: 'INVALID_SETTINGS_VALUE' },
          { status: 400 });
      }
      if (outcome.kind === 'too-large') {
        return NextResponse.json(
          {
            error: 'Your saved settings are too large to store. Remove some and try again.',
            code: 'SETTINGS_BAG_TOO_LARGE',
            limitBytes: SETTINGS_LIMITS.totalBytes,
            actualBytes: outcome.bagBytes,
          },
          { status: 413 });
      }
      const settings = outcome.settings!;

      if (changedFields.length) {
        await createAuditEvent({
          actorId: session.userId,
          action: 'settings.updated',
          targetType: 'user',
          targetId: session.userId,
          metadata: { fields: changedFields } }).catch(() => {});
      }

      return NextResponse.json({ ok: true, settings });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[SETTINGS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// SET PASSWORD HANDLER (for OAuth users adding a password)
// ═══════════════════════════════════════════════════════════════════
export async function setPasswordHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body = await request.json().catch(() => ({}));
    const { password, currentPassword } = body as { password?: string; currentPassword?: string };

    if (!password || password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    // If user has a password, verify current. Passwordless (OAuth) accounts
    // can set their first password directly — email is provider-verified.
    if (user.passwordHash) {
      if (!currentPassword) return NextResponse.json({ error: 'Current password required' }, { status: 400 });
      const valid = await verifyPassword(user.passwordHash, currentPassword);
      if (!valid) return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
    }

    const secondFactorBlocked = await secondFactorBlocker(session.userId, body);
    if (secondFactorBlocked) return secondFactorBlocked;

    if (password.length > 128) {
      return NextResponse.json({ error: 'Password must be at most 128 characters' }, { status: 400 });
    }

    const hash = await hashPassword(password);
    await prisma.user.update({ where: { id: session.userId }, data: { passwordHash: hash } });
    await prisma.userSecurity.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId, mustChangePw: false },
      update: { mustChangePw: false } });

    return NextResponse.json({ ok: true, message: 'Password updated' });
  } catch (err: any) {
    console.error('[SET PASSWORD]', err?.message || err);
    return NextResponse.json({ error: 'Failed to set password' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// PROFILE EDIT OTP HANDLERS
// ═══════════════════════════════════════════════════════════════════
/**
 * The OTP kind derives from a request-supplied field name, so it is
 * normalised before it reaches the string `kind` column: unbounded values
 * would let one session scatter arbitrary junk kinds across the OTP table,
 * and both handlers must compute the same string for the same request.
 */
function profileEditOtpKind(field: unknown): string {
  const raw = typeof field === 'string' ? field.trim().toLowerCase() : '';
  return `profile-edit:${/^[a-z0-9_-]{1,32}$/.test(raw) ? raw : 'general'}`;
}

export async function requestProfileEditOtpHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body = await request.json().catch(() => ({}));
    const { field } = body as { field?: string };

    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const email = user.email;
    const code = generateOtpCode();
    await storeOtp(session.userId, profileEditOtpKind(field) as any, code);
    await sendEmailOtp(email, code);

    return NextResponse.json({ ok: true, message: 'Verification code sent' });
  } catch (err: any) {
    console.error('[REQUEST PROFILE EDIT OTP]', err?.message || err);
    return NextResponse.json({ error: 'Failed to send verification code' }, { status: 500 });
  }
}

export async function verifyProfileEditOtpHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body = await request.json().catch(() => ({}));
    const { code, field } = body as { code?: string; field?: string };

    if (!code) return NextResponse.json({ error: 'Verification code required' }, { status: 400 });

    const valid = await verifyOtpCode(session.userId, profileEditOtpKind(field) as any, code);
    if (!valid) return NextResponse.json({ error: 'Invalid or expired code' }, { status: 400 });

    return NextResponse.json({ ok: true, verified: true });
  } catch (err: any) {
    console.error('[VERIFY PROFILE EDIT OTP]', err?.message || err);
    return NextResponse.json({ error: 'Failed to verify code' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// AVATAR UPLOAD HANDLER
// ═══════════════════════════════════════════════════════════════════
export async function avatarUploadHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const ct = request.headers.get('content-type') || '';
    let photoUrl: string | null = null;

    if (ct.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('avatar') || formData.get('file');
      if (file && file instanceof File) {
        if (file.size > 5 * 1024 * 1024) {
          return NextResponse.json({ error: 'Image must be less than 5MB' }, { status: 400 });
        }
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowed.includes(file.type)) {
          return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
        }
        const buffer = Buffer.from(await file.arrayBuffer());
        // `file.type` is what the client said, not what the bytes are; the
        // magic numbers are the only claim here the upload cannot make itself.
        if (!imageBytesMatchType(buffer, file.type)) {
          return NextResponse.json({ error: 'That file is not the image it claims to be.' }, { status: 400 });
        }
        const ext = file.type.split('/')[1] || 'jpeg';
        // Timestamp alone collided inside a second — a double-tap or two
        // devices uploading together silently overwrote one another's file.
        // The uuid slice makes every upload its own object.
        const r2Key = `avatars/${session.userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        try {
          const { storeMediaFile } = await import('@/features/media/mediaStorage');
          const stored = await storeMediaFile({ key: r2Key, body: buffer, contentType: file.type });
          photoUrl = stored.url;
        } catch (storageErr: any) {
          console.warn('[AVATAR] R2 storage failed, falling back to base64:', storageErr?.message);
          const base64 = buffer.toString('base64');
          photoUrl = `data:${file.type};base64,${base64}`;
        }
      }
    } else {
      const body = await request.json().catch(() => ({}));
      const { url } = body as { url?: string };
      if (url) {
        // Validate avatar URL: only https:// allowed, no data: or javascript: schemes
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:') {
            return NextResponse.json({ error: 'Avatar URL must use HTTPS' }, { status: 400 });
          }
          // Block known dangerous hosts / private IPs
          const hostname = parsed.hostname;
          if (
            hostname === 'localhost' ||
            hostname.endsWith('.local') ||
            /^10\./.test(hostname) ||
            /^192\.168\./.test(hostname) ||
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
            /^127\./.test(hostname) ||
            /^169\.254\./.test(hostname) ||
            /^::1$/.test(hostname) ||
            /^fc00:/.test(hostname)
          ) {
            return NextResponse.json({ error: 'Avatar URL host not allowed' }, { status: 400 });
          }
        } catch {
          return NextResponse.json({ error: 'Invalid avatar URL' }, { status: 400 });
        }
        photoUrl = url;
      }
    }

    if (!photoUrl) return NextResponse.json({ error: 'No image provided' }, { status: 400 });

    // Reject script schemes outright (XSS). A data: URL here can only be the
    // server-generated fallback from a magic-byte-validated image upload (the
    // user-supplied URL path above already enforces https-only, so data: can't
    // arrive from there) — so data:image/... is safe to keep and lets the
    // avatar work when R2/media storage isn't configured.
    if (photoUrl.startsWith('javascript:') || photoUrl.startsWith('vbscript:')) {
      return NextResponse.json({ error: 'Avatar URL scheme not allowed' }, { status: 400 });
    }
    if (photoUrl.startsWith('data:') && !photoUrl.startsWith('data:image/')) {
      return NextResponse.json({ error: 'Avatar URL scheme not allowed' }, { status: 400 });
    }

    await prisma.userProfile.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId, photoUrl },
      update: { photoUrl } });
    bustProfileCache(session.userId);

    createAuditEvent({
      actorId: session.userId,
      action: 'profile.avatar.updated',
      targetType: 'user',
      targetId: session.userId,
      metadata: { field: 'photoUrl', to: photoUrl },
      severity: 'info' }).catch((e) => console.error('[ACTIVITY]', e?.message));

    createNotification({
      userId: session.userId,
      type: 'system',
      title: 'Profile photo updated',
      body: `Your profile photo was updated.`,
      link: '/settings/edit-profile',
      metadata: { field: 'photoUrl' } }).catch((e) => console.error('[NOTIFICATION]', e?.message));

    return NextResponse.json({ ok: true, photoUrl });
  } catch (err: any) {
    console.error('[AVATAR UPLOAD]', err?.message || err);
    return NextResponse.json({ error: 'Failed to update avatar' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORT DATA HANDLER
// ═══════════════════════════════════════════════════════════════════
/**
 * Every record set an account owns, and how it is read.
 *
 * Each entry selects its columns explicitly rather than pulling whole rows and
 * removing secrets afterwards: a denylist breaks the day someone adds a
 * credential column to a table, and this payload is handed over as a file the
 * person will keep. So the secret-bearing columns — password hash, TOTP secret,
 * backup codes, passkey public keys and credential handles, API key hashes, push
 * subscription endpoints — are simply never read.
 */
const EXPORT_MAX_PER_SECTION = 10_000;

type ExportSection = {
  key: string;
  read: (userId: string, take: number) => Promise<any[]>;
};

/**
 * Which table each part is read from. The page that only asks "how much of
 * this is there" is answered with a count against the table rather than by
 * shipping rows over and measuring them here — otherwise the settings screen
 * would report one record for a log with a thousand in it.
 */
const EXPORT_MODELS: Record<string, string> = {
  emails: 'userEmail',
  phone: 'userPhone',
  profile: 'userProfile',
  preferences: 'userPreferences',
  identities: 'tirbeoIdentity',
  sessions: 'userSession',
  devices: 'userDevice',
  passkeys: 'passkey',
  logins: 'userLogin',
  activity: 'activityEvent',
  notifications: 'notification',
  emailsSent: 'email_deliveries',
  tipLogs: 'userTipLog',
  statusChanges: 'userStatusEvent',
  restrictions: 'userRestriction',
  appeals: 'userAppeal',
  deactivation: 'userDeactivation',
  deletionRequest: 'userDeletionRequest',
  pushSubscriptions: 'pushSubscription' };

const EXPORT_SECTIONS: ExportSection[] = [
  {
    key: 'emails',
    read: (id, take) => prisma.userEmail.findMany({
      where: { userId: id }, orderBy: { createdAt: 'asc' }, take,
      select: { address: true, kind: true, isDefault: true, verifiedAt: true, createdAt: true } }) },
  {
    key: 'phone',
    read: (id, take) => prisma.userPhone.findMany({
      where: { userId: id }, take, select: { number: true, verifiedAt: true, updatedAt: true } }) },
  {
    key: 'profile',
    read: (id, take) => prisma.userProfile.findMany({
      where: { userId: id }, take,
      select: {
        name: true, bio: true, pronouns: true, gender: true, birthday: true, location: true,
        photoUrl: true, bannerUrl: true, website: true, jobRole: true, jobCompany: true,
        jobPlace: true, jobStarted: true, skills: true, followers: true, following: true,
        createdAt: true, updatedAt: true } }) },
  {
    key: 'preferences',
    read: (id, take) => prisma.userPreferences.findMany({
      where: { userId: id }, take,
      select: { appearance: true, notif: true, privacy: true, misc: true, updatedAt: true } }) },
  {
    key: 'identities',
    read: (id, take) => prisma.tirbeoIdentity.findMany({
      where: { userId: id }, orderBy: { createdAt: 'asc' }, take,
      select: { username: true, email: true, verifiedSource: true, verifiedAt: true, createdAt: true } }) },
  {
    key: 'sessions',
    read: (id, take) => prisma.userSession.findMany({
      where: { userId: id }, orderBy: { createdAt: 'asc' }, take,
      select: {
        deviceName: true, userAgent: true, ipAddress: true, location: true, status: true,
        createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true } }) },
  {
    key: 'devices',
    read: (id, take) => prisma.userDevice.findMany({
      where: { userId: id }, orderBy: { createdAt: 'asc' }, take,
      select: { deviceName: true, userAgent: true, ipAddress: true, location: true, status: true, createdAt: true, lastUsedAt: true } }) },
  {
    // The fact that a passkey exists, on which device, and when it was last
    // used. Not the credential handle or the public key: those are the account's
    // secrets to check against, and they are useless to a person reading a file.
    key: 'passkeys',
    read: (id, take) => prisma.passkey.findMany({
      where: { userId: id }, orderBy: { createdAt: 'asc' }, take,
      select: { deviceName: true, transports: true, createdAt: true, lastUsedAt: true } }) },
  {
    key: 'logins',
    read: (id, take) => prisma.userLogin.findMany({
      where: { userId: id }, orderBy: { createdAt: 'asc' }, take }) },
  {
    key: 'activity',
    read: (id, take) => prisma.activityEvent.findMany({
      where: { userId: id }, orderBy: { createdAt: 'asc' }, take,
      select: { kind: true, title: true, detail: true, severity: true, metadata: true, ipAddress: true, userAgent: true, createdAt: true } }) },
  {
    key: 'notifications',
    read: (id, take) => prisma.notification.findMany({
      where: { userId: id }, orderBy: { createdAt: 'asc' }, take,
      select: { type: true, title: true, body: true, link: true, isRead: true, createdAt: true } }) },
  {
    key: 'emailsSent',
    read: (id, take) => prisma.email_deliveries.findMany({
      where: { userId: id }, orderBy: { createdAt: 'asc' }, take,
      select: { toEmail: true, event: true, eventKey: true, category: true, subject: true, status: true, provider: true, openedAt: true, clickedAt: true, createdAt: true } }) },
  {
    key: 'tipLogs',
    read: (id, take) => prisma.userTipLog.findMany({ where: { userId: id }, orderBy: { sentAt: 'asc' }, take }) },
  {
    key: 'statusChanges',
    read: (id, take) => prisma.userStatusEvent.findMany({ where: { userId: id }, orderBy: { createdAt: 'asc' }, take }) },
  {
    key: 'restrictions',
    read: (id, take) => prisma.userRestriction.findMany({ where: { userId: id }, orderBy: { startedAt: 'asc' }, take }) },
  {
    key: 'appeals',
    read: (id, take) => prisma.userAppeal.findMany({ where: { userId: id }, orderBy: { createdAt: 'asc' }, take }) },
  {
    key: 'deactivation',
    read: (id, take) => prisma.userDeactivation.findMany({ where: { userId: id }, take }) },
  {
    key: 'deletionRequest',
    read: (id, take) => prisma.userDeletionRequest.findMany({ where: { userId: id }, take }) },
  {
    // Which browsers were given a push channel, and when. The endpoint URL and
    // its keys can push to the device, so they are not part of a downloadable
    // file.
    key: 'pushSubscriptions',
    read: (id, take) => prisma.pushSubscription.findMany({
      where: { userId: id }, orderBy: { createdAt: 'asc' }, take,
      select: { userAgent: true, createdAt: true, lastUsedAt: true } }) },
];

/** The security settings of an account, with the secrets left out on purpose. */
async function readSecuritySummary(userId: string) {
  const [security, links] = await Promise.all([
    prisma.userSecurity.findUnique({ where: { userId }, select: { totpEnabled: true, backupCodes: true, mustChangePw: true, updatedAt: true } }),
    readOauthLinks(userId),
  ]);
  return {
  twoFactorEnabled: !!security?.totpEnabled,
  backupCodesRemaining: Array.isArray(security?.backupCodes) ? (security!.backupCodes as any[]).length : 0,
  mustChangePassword: !!security?.mustChangePw,
  updatedAt: security?.updatedAt ?? null,
  connectedAccounts: [
    links.google && 'Google',
    links.github && 'GitHub',
    links.discord && 'Discord',
  ].filter(Boolean) as string[] };
}

const json = (raw: unknown): Record<string, any> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {};

/**
 * The most recent enforcement facts for an account, read from the tables that
 * replaced the old ban/suspend columns: a live restriction carries the reason and
 * the until date, and the status-event history carries the reference codes. A
 * legacy account without a stored code gets one minted AND PERSISTED via
 * ensureRefCode — the export must only ever contain a code that exists in the
 * database and can be quoted back to staff.
 */
async function latestEnforcement(userId: string) {
  const [restriction, banEvent, suspendEvent] = await Promise.all([
    prisma.userRestriction.findFirst({
      where: { userId }, orderBy: { startedAt: 'desc' },
      select: { detail: true, endsAt: true } }).catch(() => null),
    prisma.userStatusEvent.findFirst({
      where: { userId, toStatus: 'banned' }, orderBy: { createdAt: 'desc' },
      select: { metadata: true } }).catch(() => null),
    prisma.userStatusEvent.findFirst({
      where: { userId, toStatus: 'suspended' }, orderBy: { createdAt: 'desc' },
      select: { metadata: true } }).catch(() => null),
  ]);
  const banMeta = json(banEvent?.metadata);
  const suspMeta = json(suspendEvent?.metadata);
  return {
    reason: restriction?.detail ?? suspMeta.reason ?? banMeta.reason ?? null,
    until: restriction?.endsAt
      ?? (suspMeta.until ? new Date(suspMeta.until) : null)
      ?? (banMeta.until ? new Date(banMeta.until) : null),
    banRefCode: (banMeta.refCode as string | undefined) ?? await ensureRefCode(userId, 'ban'),
    suspendRefCode: (suspMeta.refCode as string | undefined) ?? await ensureRefCode(userId, 'suspend'),
  };
}

/**
 * The `account` block of the export, assembled from every table the old single
 * users row was split across. The response keeps the exact same keys — a caller
 * that downloaded an export before the split reads the same field names.
 */
async function accountExportSnapshot(userId: string): Promise<Record<string, unknown>> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, username: true, email: true, status: true, isAdmin: true,
      lastActiveAt: true, lastLoginAt: true, createdAt: true, updatedAt: true,
      profile: { select: { name: true, photoUrl: true } },
      preferences: { select: { appearance: true, notif: true, misc: true } },
      security: { select: { totpEnabled: true } },
      emails: { select: { address: true, kind: true, isDefault: true, verifiedAt: true } } },
  });
  if (!user) return {};

  const appearance = json(user.preferences?.appearance);
  const notif = json(user.preferences?.notif);
  const misc = json(user.preferences?.misc);
  const emailRow = user.emails.find((e) => e.address === user.email)
    || user.emails.find((e) => e.isDefault)
    || user.emails.find((e) => e.kind === 'primary');

  const [deletion, enforce] = await Promise.all([
    prisma.userDeletionRequest.findUnique({
      where: { userId }, select: { reason: true, finalAt: true, cancelledAt: true, executedAt: true } }).catch(() => null),
    latestEnforcement(userId),
  ]);
  const deletionActive = user.status === 'deletion_pending' && !!deletion && !deletion.cancelledAt && !deletion.executedAt;

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    emailVerified: emailRow?.verifiedAt != null,
    name: user.profile?.name ?? null,
    photoUrl: user.profile?.photoUrl ?? null,
    status: user.status,
    isAdmin: user.isAdmin,
    theme: appearance.theme ?? 'system',
    language: appearance.language ?? 'en',
    timezone: appearance.timezone ?? null,
    consents: json(misc.consents),
    notificationPreferences: notif,
    emailUnsubscribed: json(notif.unsubscribed),
    is2FAEnabled: !!user.security?.totpEnabled,
    isBanned: user.status === 'banned',
    isSuspended: user.status === 'suspended',
    suspendReason: enforce.reason,
    suspendedUntil: enforce.until,
    banRefCode: enforce.banRefCode,
    suspendRefCode: enforce.suspendRefCode,
    deletedAt: user.status === 'deleted' ? user.updatedAt : null,
    scheduledDeletionAt: deletionActive ? deletion!.finalAt : null,
    deletionReason: deletionActive ? (deletion!.reason ?? null) : null,
    lastActiveAt: user.lastActiveAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt };
}

/**
 * The whole archive, gathered once and handed over in whichever format the
 * request recorded.
 *
 * `POST /api/user/export-data {format}` writes the request and answers with its
 * id — it builds nothing, so the sheet that was cancelled mid-way leaves no
 * record either, and only a confirmed choice gets as far as this.
 * `GET /api/user/export-data?request=<id>` builds that request now, in the
 * format stored with it, and `GET /api/user/export-data` on its own stays what
 * it always was: the JSON archive, made as it is asked for.
 */
export async function exportDataHandler(request: NextRequest) {
  const url = new URL(request.url);
  const wantsSummary = url.searchParams.get('summary') === '1';
  const requestId = url.searchParams.get('request');

  // The ledger row this call is building, if it has one. Assigned inside the try
  // and read in the catch, so a build that dies part-way is written down as
  // failed rather than left sitting at "pending" pretending to be in progress.
  let record: ExportRequestRecord | null = null;

  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, username: true, email: true, status: true, profile: { select: { name: true } } } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const exportedAt = new Date();
    const stem = user.username || user.email.split('@')[0];

    // ── Create a request (the sheet's "Confirm") ─────────────────────────
    if (request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { format?: unknown } | null;
      const format = parseRequestedExportFormat(body?.format);
      if (!format) {
        return NextResponse.json(
          { error: 'Pick a format the account can write: json or html.' },
          { status: 400 },
        );
      }
      const fileName = exportFileName(stem, exportedAt, format);
      const created = await createExportRequest(session.userId, format, fileName);
      return NextResponse.json(
        {
          ok: true,
          requestId: created.id,
          format: created.format,
          fileName: created.fileName,
          requestedAt: created.requestedAt.toISOString() },
        { status: 201 },
      );
    }

    // ── Which format this call writes, and under what name ───────────────
    // A named request honours what was chosen when it was made; the bare route
    // is the old JSON download and is recorded as one so it still shows up in
    // the account's history.
    let format: ExportFormat = 'json';
    let fileName = exportFileName(stem, exportedAt, 'json');
    if (requestId) {
      const loaded = await loadExportRequest(session.userId, requestId);
      if (!loaded) {
        return NextResponse.json({ error: 'No such export request on this account.' }, { status: 404 });
      }
      format = loaded.format;
      fileName = loaded.fileName;
      record = loaded;
    } else if (!wantsSummary) {
      try {
        record = await createExportRequest(session.userId, 'json', fileName);
      } catch (err: any) {
        // A ledger that won't take the write must not withhold the file.
        console.error('[EXPORT LEDGER CREATE]', err?.message || err);
        record = null;
      }
    }

    // The account row itself, gathered from the tables the old single row was
    // split across — same field names the export has always carried.
    const account = await accountExportSnapshot(session.userId);

    const [sections, security] = await Promise.all([
      Promise.all(EXPORT_SECTIONS.map(async (section) => {
        if (wantsSummary) {
          const total = await (prisma as any)[EXPORT_MODELS[section.key]]
            .count({ where: { userId: session.userId } })
            .catch((err: any) => {
              console.error(`[EXPORT COUNT ${section.key}]`, err?.message || err);
              return null;
            });
          if (total === null) return { key: section.key, rows: null as any[] | null, failed: true, truncated: false, count: 0 };
          return { key: section.key, rows: [] as any[], failed: false, truncated: false, count: Number(total) };
        }
        const rows = await section.read(session.userId, EXPORT_MAX_PER_SECTION + 1).catch((err) => {
          // One unreadable set must not cost the person the whole export; say
          // which one is missing instead of handing over a shorter file quietly.
          console.error(`[EXPORT ${section.key}]`, err?.message || err);
          return null;
        });
        if (rows === null) return { key: section.key, rows: null as any[] | null, failed: true, count: 0 };
        const truncated = rows.length > EXPORT_MAX_PER_SECTION;
        const kept = truncated ? rows.slice(0, EXPORT_MAX_PER_SECTION) : rows;
        return { key: section.key, rows: kept, failed: false, truncated, count: kept.length };
      })),
      readSecuritySummary(session.userId),
    ]);

    const counts: Record<string, number> = {};
    const failed: string[] = [];
    const truncated: string[] = [];
    for (const section of sections) {
      counts[section.key] = section.count;
      if (section.failed) failed.push(section.key);
      if ((section as any).truncated) truncated.push(section.key);
    }

    if (wantsSummary) {
      const recent = await listExportRequests(session.userId, 10);
      return NextResponse.json({
        exportedAt: exportedAt.toISOString(),
        fileName,
        counts,
        failed,
        truncated,
        security,
        recent: recent.map((row) => ({
          id: row.id,
          at: row.requestedAt,
          bytes: row.bytes,
          counts: row.counts,
          format: row.format,
          status: row.status,
          fileName: row.fileName,
          builtAt: row.builtAt,
          missing: row.missing,
          truncated: row.truncated })) });
    }

    const archive = {
      format: 'tirbeo-account-export/1',
      exportedAt: exportedAt.toISOString(),
      note: 'Everything Tirbeo holds about this account, as it stood at the time of export. Secrets are not included: no password, no authenticator code or recovery codes, no passkey or API-key credentials, no push endpoints.',
      account,
      security,
      sections: Object.fromEntries(sections.map((section) => [section.key, section.rows])),
      counts,
      missing: failed,
      truncated };

    // The same gathered archive either way: JSON for the machine-readable
    // archive, HTML for the report a person opens in a browser. Which of the two
    // it is comes from the request, and `renderExportArchive` is the only place
    // that decides it.
    const { body, contentType } = renderExportArchive(archive, format);
    const bytes = Buffer.byteLength(body, 'utf8');

    if (record) {
      await completeExportRequest(record.id, { bytes, counts, missing: failed, truncated });
    }

    // The download is a data-rights action: an audit write or a notification
    // email must never be able to take the file away, so both are best effort
    // and neither is awaited in the failure path.
    try {
      await createAuditEvent({
        actorId: session.userId,
        action: 'data.exported',
        targetType: 'user',
        targetId: session.userId,
        metadata: { fileName, bytes, counts, format, requestId: record?.id ?? null },
        severity: 'info' });
    } catch (err: any) {
      console.error('[EXPORT LEDGER]', err?.message || err);
    }
    try {
      // The archive is already gathered; the notice about it must not be part of
      // how long the download takes to start, so the mailbox lookup rides the
      // same deferred chain instead of awaiting before the response.
      void primaryEmailForUser(session.userId)
        .then((mailbox) => mailbox || user.email)
        .then((to) => sendTemplateEmailAfter(to, 'export_ready', {
          name: user.profile?.name || to,
          exportedAt: exportedAt.toLocaleString() }))
        .catch(() => {});
    } catch (err: any) {
      console.error('[EXPORT NOTICE]', err?.message || err);
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-Export-Bytes': String(bytes),
        'X-Export-Format': format } });
  } catch (err: any) {
    if (record) await failExportRequest(record.id, err?.message || String(err));
    console.error('[EXPORT DATA]', err?.message || err);
    return NextResponse.json({ error: 'Your data could not be gathered. Nothing was downloaded — please try again.' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// DELETE ACCOUNT — TWO STEPS (acknowledge → code to the sign-in email →
// 30-day window). The lifecycle itself lives in the account-lifecycle
// module; this is the HTTP surface the settings screens call.
//   POST { step:'request' }  → send the code (rate-limited like a password reset)
//   POST { step:'verify', deleteCode, reason, +proof } → verify + schedule deletion
//   DELETE | POST ?cancel=1  → cancel inside the window
//   GET                      → current deletion state
// The code is sent to the SIGN-IN EMAIL and reuses the shared OTP machinery
// under its own kind ('account_delete'), so it can never be spent elsewhere.
// ═══════════════════════════════════════════════════════════════════
export async function deleteAccountRequestHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const url = new URL(request.url);
    const email = await primaryEmailOf(session.userId);

    // GET → is a deletion pending, and when it lands?
    if (request.method === 'GET') {
      const active = await activeDeletionFor(session.userId);
      return NextResponse.json({
        pending: !!active,
        finalAt: active ? active.finalAt.toISOString() : null,
        daysRemaining: active ? Math.max(0, Math.ceil((active.finalAt.getTime() - Date.now()) / 86_400_000)) : null });
    }

    // Cancel — either the DELETE verb or ?cancel=1.
    if (request.method === 'DELETE' || url.searchParams.get('cancel') === '1') {
      const result = await cancelDeletion(session.userId);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === 'User not found' ? 404 : 400 });
      bustProfileCache(session.userId);
      logSecurityEvent({ request, userId: session.userId, eventType: 'security.deletion_cancelled', severity: 'info', details: {} }).catch(() => {});
      return NextResponse.json({ ok: true, message: 'Deletion cancelled' });
    }

    const body = await request.json().catch(() => ({}));
    // `deleteCode`, not `code`: `code` is the field the re-auth guard reads as
    // an authenticator proof, and a deletion typed into it would be checked
    // as a TOTP and rejected as one.
    const { step, deleteCode, reason } = body as { step?: string; deleteCode?: string; reason?: string };

    // Nothing can be re-requested while a deletion is already on the clock.
    if (await activeDeletionFor(session.userId)) {
      return NextResponse.json({ error: 'Account deletion already scheduled', message: 'Your account is already scheduled for deletion. Cancel it to start over.' }, { status: 409 });
    }

    // Step 1 — send the code to the sign-in email.
    if (!step || step === 'request') {
      if (!email) return NextResponse.json({ error: 'No sign-in email on this account to send a code to.' }, { status: 400 });

      const issued = await issueDeletionCode(session.userId, email);
      if (!issued.ok) {
        const secs = Math.ceil(issued.remainingMs / 1000);
        return NextResponse.json({ error: `Please wait ${secs}s before requesting another code.` }, { status: 429 });
      }

      const { sendTemplateEmail } = await import('@/features/email/email');
      // Awaited — but only to a point. Telling someone to check an inbox
      // that the provider never accepted is how a wrong code gets typed three
      // times, so the send's answer is worth waiting for; waiting forever is
      // not. SMTP here has been taking 8–10s, and a screen that gives up mid-
      // send shows "code sent" on the server and no code box on the phone.
      // Past the wait the send keeps running in the background: the person
      // gets the sheet with the box, the mail lands when it lands, and a late
      // failure is answered by the resend link, not a dead end.
      // `name` and `lifetimeMinutes` are not decoration: a variable the render
      // step never sees stays in the mail as its literal `{{name}}`, and the
      // code's real life is the core's TTL, not a number typed into the copy.
      const row = await prisma.user.findUnique({ where: { id: session.userId }, select: { profile: { select: { name: true } } } });
      const sendP: Promise<{ success?: boolean; error?: string }> = sendTemplateEmail(email, 'delete_account_otp', {
        otp: issued.code,
        name: (row?.profile?.name || '').trim() || email.split('@')[0],
        lifetimeMinutes: String(OTP_TTL_MINUTES),
      }).catch((e: any) => ({ success: false, error: e?.message || 'mail send failed' }));
      const waited = await Promise.race([
        sendP,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
      ]);
      if (waited === null) {
        sendP.then((late) => {
          if (!late?.success) console.error('[DELETE OTP] late send failed:', late?.error);
        }).catch(() => {});
      } else if (!waited.success) {
        console.error('[DELETE OTP]', waited.error);
        return NextResponse.json(
          { error: 'The verification code could not be sent right now. Please try again in a moment.' },
          { status: 502 },
        );
      }

      // Ledger line so the person can see the code was sent, without any
      // once-per-week lockout (the resend cooldown is the rate limit).
      await prisma.activityEvent.create({
        data: { userId: session.userId, kind: 'account.delete-code', title: 'Deletion code sent', detail: email, metadata: { targetType: 'user', to: email }, severity: 'warning' } }).catch(() => {});

      // Masked, and worth repeating as a field: the address here is the one the
      // code actually went to, which a client's own cached profile has no way
      // of guaranteeing.
      return NextResponse.json({
        ok: true,
        step: 'request',
        email: maskEmail(email),
        message: `Verification code sent to ${maskEmail(email)}`,
      });
    }

    // Step 2 — verify the code → open the 30-day window.
    if (step === 'verify') {
      if (!deleteCode) {
        // Names which fields actually arrived (never their values). A browser
        // running a page chunk from before the `code` → `deleteCode` rename
        // lands here with the deletion code under `code`, and this line is the
        // one difference between "nobody typed it" and "the wrong door knocked".
        console.warn('[DELETE ACCOUNT] verify without deleteCode — body keys:',
          Object.keys(body).join(',') || '(none)');
        return NextResponse.json({ error: 'Verification code is required' }, { status: 400 });
      }

      // Deleting an account is the most sensitive thing this app does, so the
      // session cookie alone doesn't do it: the request must also carry a
      // fresh proof (password, authenticator, emailed code or passkey — the
      // doors this account can open), and an account with "require 2FA for
      // sensitive actions" on is held to that policy here like everywhere else.
      const proof = await requireReauth(request, session.userId, { body });
      if ('response' in proof) return proof.response;

      const valid = await consumeDeletionCode(session.userId, String(deleteCode));
      if (!valid) return NextResponse.json({ error: 'Invalid or expired code' }, { status: 400 });

      const { finalAt } = await scheduleDeletion(session.userId, { reason: reason ?? null, keepSessionId: session.sessionId ?? null });
      bustProfileCache(session.userId);

      logSecurityEvent({ request, userId: session.userId, eventType: 'security.deletion_scheduled', severity: 'warning', details: { reason: reason || 'user_requested' } }).catch(() => {});

      if (email) {
        const { getDashboardBaseUrl } = await import('@/config/app-urls');
        // No `name`: the greeting is the account's display name (or the address
        // prefix when it has none), and the sentence below names the mailbox.
        // Passing the address as the name greeted people with their own email.
        sendTemplateEmailAfter(email, 'account_deleted', {
          primaryEmail: email,
          dateLabel: finalAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
          dashboardUrl: getDashboardBaseUrl() });
      }

      return NextResponse.json({
        ok: true,
        step: 'verify',
        scheduledAt: finalAt,
        daysRemaining: Math.max(0, Math.ceil((finalAt.getTime() - Date.now()) / 86_400_000)),
        message: 'Account scheduled for deletion in 30 days' });
    }

    return NextResponse.json({ error: 'Invalid step. Use "request" or "verify".' }, { status: 400 });
  } catch (err: any) {
    console.error('[DELETE ACCOUNT]', err?.message || err);
    return NextResponse.json({ error: 'Failed to process deletion request' }, { status: 500 });
  }
}

/** The account's primary sign-in email — where the deletion code must go. */
async function primaryEmailOf(userId: string): Promise<string | null> {
  const row = await prisma.userEmail.findFirst({ where: { userId, kind: 'primary' }, select: { address: true } }).catch(() => null);
  if (row?.address) return row.address;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }).catch(() => null);
  return user?.email ?? null;
}

// ═══════════════════════════════════════════════════════════════════
// PROCESS SCHEDULED DELETIONS (hard-delete past the window)
// The single bounded implementation is the permanent-deletion sweep in
// jobs/jobs-permanent-deletion.ts, driven by the lifecycle tables (status +
// UserDeletionRequest). This kept the same name for the admin panel and the
// hourly job; it now just forwards.
// ═══════════════════════════════════════════════════════════════════
export async function processScheduledDeletions(): Promise<{ deleted: number }> {
  const { permanentDeletionJob } = await import('@/jobs/jobs-permanent-deletion');
  return permanentDeletionJob();
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC PROFILE HANDLER
// ═══════════════════════════════════════════════════════════════════
export async function publicProfileHandler(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId') || url.pathname.split('/').pop();

    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

    // What this endpoint answers is the same for every viewer — id, handle,
    // join date, name and photo — so one entry per profile serves them all.
    const cacheKey = `publicProfile:${userId}`;
    const cached = publicProfileCache.get(cacheKey);
    if (cached) return NextResponse.json(cached);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, username: true, createdAt: true,
        profile: { select: { name: true, photoUrl: true } } } });

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    const payload = { ok: true, profile: {
      id: user.id,
      name: user.profile?.name ?? null,
      username: user.username,
      photoUrl: user.profile?.photoUrl ?? null,
      createdAt: user.createdAt } };
    publicProfileCache.set(cacheKey, payload);
    return NextResponse.json(payload);
  } catch (err: any) {
    console.error('[PUBLIC PROFILE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch profile' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// CONSENT HISTORY HANDLER — GET /api/consent-history
// Returns all consent change events for the current user
// ═══════════════════════════════════════════════════════════════════
export async function consentHistoryHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;

    const [events, total] = await Promise.all([
      prisma.activityEvent.findMany({
        where: {
          userId: session.userId,
          kind: 'consent.updated' },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          kind: true,
          metadata: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true } }),
      prisma.activityEvent.count({
        where: {
          userId: session.userId,
          kind: 'consent.updated' } }),
    ]);

    // Format events for frontend consumption
    const formattedEvents = events.map((event: any) => {
      const meta = (event.metadata as Record<string, any>) || {};
      const previous = meta.previous || {};
      const current = meta.privacy || {};
      const changedFields = meta.changedFields || [];

      return {
        id: event.id,
        timestamp: event.createdAt.toISOString(),
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        changes: changedFields.map((field: string) => ({
          field,
          oldValue: previous[field] ?? null,
          newValue: current[field] ?? null })),
        previous,
        current };
    });

    return NextResponse.json({
      events: formattedEvents,
      total,
      limit,
      offset });
  } catch (err: any) {
    console.error('[CONSENT HISTORY]', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch consent history' }, { status: 500 });
  }
}
