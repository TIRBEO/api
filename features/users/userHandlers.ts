import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { hashPassword, verifyPassword } from '@/features/auth/password';
import { generateOtpCode, storeOtp, verifyOtpCode, sendEmailOtp } from '@/features/auth/otp';
import { jsonUnauthorized } from '@/shared/response';
import { sendTemplateEmail } from '@/features/email/email';
import { createNotification, describeDevice, getClientIpFromRequest, DEFAULT_PREFS } from '@/features/notifications/notifications';
import { sanitizeInput } from '@/features/security/security';
import { verifyMergeToken } from '@/features/auth/jwt';
import { bustProfileCache } from '@/features/auth/authHandlers';
import { createTtlCache } from '@/infrastructure/cache';
import { logPerformance } from '@/infrastructure/observability/perf';
import { trackQuery } from '@/infrastructure/observability/queryMonitor';
import { createAuditEvent } from '@/features/security/audit';
import { logSecurityEvent } from '@/features/security/security';
import { withRetry } from '@/infrastructure/db/prisma';

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
function bustPreferencesCache(userId: string) { preferencesCache.delete(userId); }

// Cache for GET /api/user/activity — activity page polls this.
// 5s TTL: activity logs are append-only and stale data is acceptable.
const activityCache = createTtlCache<{ events: any[]; total: number }>(5_000, 2000, 'activity');

// Cache for GET /api/profile/public — public profiles rarely change.
// 30s TTL: safe for public data, busts naturally.
const publicProfileCache = createTtlCache<any>(30_000, 2000, 'publicProfile');

// Debounce for POST /api/heartbeat — dashboard polls this every ~30s.
// Skip the DB write if we already updated within the last 25s.
const heartbeatDebounce = new Map<string, number>();
const HEARTBEAT_DEBOUNCE_MS = 25_000;

const PROFILE_FIELD_LABELS: Record<string, string> = {
  name: 'Display name', username: 'Username', photoUrl: 'Profile photo',
  phoneNumber: 'Phone number', occupation: 'Occupation', bio: 'Bio',
  website: 'Website', linkedin: 'LinkedIn', githubUsername: 'GitHub username',
  twitter: 'Twitter / X', country: 'Location', timezone: 'Timezone',
  language: 'Language', theme: 'Theme', dateFormat: 'Date format', timeFormat: 'Time format',
  companyName: 'Company name', companyRole: 'Job title', industry: 'Industry',
  companySize: 'Company size', gender: 'Gender', birthday: 'Birthday',
  secondaryEmail: 'Recovery email',
};

export async function extendedProfileHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    if (request.method === 'GET') {
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: {
          id: true, email: true, name: true, photoUrl: true, username: true,
          phoneNumber: true, occupation: true, bio: true,
           secondaryEmail: true,
           secondaryEmailVerified: true,
           website: true, linkedin: true, githubUsername: true, twitter: true,
           country: true, timezone: true, language: true, theme: true,
           dateFormat: true, timeFormat: true,
           emailVerified: true, phoneVerified: true, is2FAEnabled: true,
           totpSecret: true,
           companyName: true, companyRole: true, industry: true, companySize: true,
           gender: true, birthday: true,
           createdAt: true, updatedAt: true,
           lastLoginAt: true, lastLoginIp: true, lastActiveAt: true,
           passwordHash: true, googleId: true, githubId: true, discordId: true,
            mustChangePassword: true, scheduledDeletionAt: true, deletionReason: true,
            consents: true, backupCodes: true,
         },
       });
      if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
      const { passwordHash, googleId, githubId, discordId, totpSecret, ...safe } = user;
      const consentData = ((user as any).consents as Record<string, any>) || {};
      const prefs = consentData;
      const backupCodes = (user as any).backupCodes as any[] | null;
      const recoveryCodesCount = Array.isArray(backupCodes) ? backupCodes.length : 0;
      return NextResponse.json({
        ...safe,
        hasPassword: !!passwordHash,
        hasGoogle: !!googleId,
        hasGithub: !!githubId,
        hasDiscord: !!discordId,
        totpEnabled: !!totpSecret,
        recoveryEmail: safe.secondaryEmail || undefined,
        recoveryEmailVerified: !!safe.secondaryEmailVerified,
        recoveryPhone: safe.phoneNumber || undefined,
        recoveryCodesCount,
        skipPassword: !!consentData.skipPassword,
        phones: safe.phoneNumber ? [{ number: safe.phoneNumber, verified: safe.phoneVerified }] : [],
        lastPasswordChange: safe.updatedAt?.toISOString() || null,
      });
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
      }).passthrough();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        console.error('[PATCH /api/profile] Zod validation error:', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
        return NextResponse.json({ error: 'Invalid preferences data', details: parsed.error.issues }, { status: 400 });
      }
      const raw: any = { ...parsed.data };
      // Map frontend fields to Prisma fields
      const data: any = {};
      if (raw.name) data.name = raw.name;
      if (raw.photoUrl !== undefined) data.photoUrl = raw.photoUrl;
      if (raw.phoneNumber !== undefined) data.phoneNumber = raw.phoneNumber;
      if (raw.occupation !== undefined) data.occupation = raw.occupation;
      if (raw.bio !== undefined) data.bio = raw.bio;
      if (raw.website !== undefined) data.website = raw.website;
      if (raw.linkedin !== undefined) data.linkedin = raw.linkedin;
      if (raw.github !== undefined) data.githubUsername = raw.github;
      if (raw.githubUsername !== undefined) data.githubUsername = raw.githubUsername;
      if (raw.twitter !== undefined) data.twitter = raw.twitter;
      if (raw.country !== undefined) data.country = raw.country;
      if (raw.timezone !== undefined) data.timezone = raw.timezone;
      if (raw.language !== undefined) data.language = raw.language;
      if (raw.theme !== undefined) data.theme = raw.theme;
      if (raw.dateFormat !== undefined) data.dateFormat = raw.dateFormat;
      if (raw.timeFormat !== undefined) data.timeFormat = raw.timeFormat;

      if (raw.companyName !== undefined) data.companyName = raw.companyName;
      if (raw.companyRole !== undefined) data.companyRole = raw.companyRole;
      if (raw.industry !== undefined) data.industry = raw.industry;
      if (raw.companySize !== undefined) data.companySize = raw.companySize;
      if (raw.gender !== undefined) data.gender = raw.gender;
      if (raw.birthday !== undefined) {
        if (!raw.birthday || raw.birthday === '') {
          data.birthday = null;
        } else {
          const d = new Date(raw.birthday);
          data.birthday = isNaN(d.getTime()) ? null : d;
        }
      }
      if (raw.username !== undefined) data.username = raw.username;
       if (raw.secondaryEmail !== undefined) {
         data.secondaryEmail = raw.secondaryEmail;
         // A new recovery email must be re-verified before it can be trusted again.
         data.secondaryEmailVerified = false;
       }
      for (const field of ['name', 'occupation', 'bio', 'linkedin', 'twitter', 'country', 'companyName', 'companyRole', 'industry', 'companySize', 'gender'] as const) {
        if (typeof data[field] === 'string') data[field] = sanitizeInput(data[field], 2000);
      }
      // Fetch current values for the editable fields so we can detect real changes
      const editableFields = ['name','username','photoUrl','phoneNumber','occupation','bio','website','linkedin','githubUsername','twitter','country','timezone','language','theme','dateFormat','timeFormat','companyName','companyRole','industry','companySize','gender','birthday','secondaryEmail'] as const;
      const prev = await prisma.user.findUnique({
        where: { id: session.userId },
        select: Object.fromEntries(editableFields.map((f) => [f, true])) as any,
      }).catch(() => null);

      const updated = await prisma.user.update({
        where: { id: session.userId },
        data,
        select: {
          id: true, email: true, name: true, photoUrl: true, username: true,
          phoneNumber: true, occupation: true, bio: true,
           secondaryEmail: true,
           secondaryEmailVerified: true,
           website: true, linkedin: true, githubUsername: true, twitter: true,
           country: true, timezone: true, language: true, theme: true,
           dateFormat: true, timeFormat: true,
           companyName: true, companyRole: true, industry: true, companySize: true,
           gender: true, birthday: true,
           emailVerified: true, phoneVerified: true, is2FAEnabled: true,
           createdAt: true, updatedAt: true,
        },
      });

      const same = (a: any, b: any) => {
        if (a instanceof Date || b instanceof Date) return new Date(a as any).getTime() === new Date(b as any).getTime();
        return (a ?? null) === (b ?? null) || String(a ?? '') === String(b ?? '');
      };
      // Only fields that actually changed value (NOT every submitted key).
      const changedFields = editableFields.filter(
        (f) => data[f] !== undefined && !same(prev?.[f], data[f])
      );

      if (changedFields.length > 0) {
        bustProfileCache(session.userId);
        for (const field of changedFields) {
          const label = PROFILE_FIELD_LABELS[field] ?? field.replace(/([A-Z])/g, ' $1').trim();
          const rawValue = updated[field as keyof typeof updated];
          const displayValue = rawValue instanceof Date
            ? new Date(rawValue).toISOString().split('T')[0]
            : (rawValue ?? null);
          const hasValue = displayValue !== null && String(displayValue) !== '';

          // Separate, accurate activity log per changed field
          createAuditEvent({
            actorId: session.userId,
            action: `profile.${field}.updated`,
            targetType: 'user',
            targetId: session.userId,
            metadata: { field, from: prev?.[field] ?? null, to: displayValue },
            severity: 'info',
          }).catch((e) => console.error('[ACTIVITY]', e?.message));

          // Separate, accurate notification per changed field
          createNotification({
            userId: session.userId,
            type: 'system',
            title: `${label} updated`,
            body: hasValue
              ? `Your ${label.toLowerCase()} was changed to "${displayValue}".`
              : `Your ${label.toLowerCase()} was removed.`,
            link: '/account/profile',
            metadata: { field, from: prev?.[field] ?? null, to: displayValue },
          }).catch((e) => console.error('[NOTIFICATION]', e?.message));
        }
      }

      return NextResponse.json(updated);
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
    const { currentPassword, newPassword, otpCode } = body;
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

    const { checkPasswordBreach } = await import('@/features/auth/breach');
    const breach = await checkPasswordBreach(newPassword);
    if (breach.breached) {
      return NextResponse.json({ error: 'This password has been found in known breaches. Please choose a different password.' }, { status: 400 });
    }

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: session.userId }, data: { passwordHash: newHash, mustChangePassword: false } });
    await prisma.session.deleteMany({
      where: { userId: session.userId, NOT: { id: session.sessionId } },
    });
    logSecurityEvent({ request, userId: session.userId, eventType: 'security.password_changed', details: { method: 'password' } }).catch(() => {});

    const userEmail = (await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } }))?.email || '';
    if (userEmail) {
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
      sendTemplateEmail(userEmail, 'password_changed', {
        name: userEmail.split('@')[0],
        changedAt: new Date().toLocaleString(),
        ipAddress: ip,
      }).catch(() => {});
    }

    const loginIp = getClientIpFromRequest(request);
    const loginDevice = describeDevice(request.headers.get('user-agent'));
    await createNotification({
      userId: session.userId,
      type: 'security',
      title: 'Password changed',
      body: `Your password was changed from ${loginDevice} (IP ${loginIp || 'unknown'}). All other sessions were signed out.`,
      link: '/account/security',
      metadata: { ip: loginIp, device: loginDevice, method: 'Password' },
      skipEmail: true,
    }).catch((e) => console.error('[NOTIFICATION]', (e as Error)?.message));


    return NextResponse.json({ error: 'Password changed' }, { status: 200 });
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
      const sessions = await prisma.session.findMany({
        where: { userId: session.userId, status: { not: 'revoked' }, expiresAt: { gte: new Date() } },
        orderBy: { lastUsedAt: 'desc' },
        select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true, lastUsedAt: true },
      });
      const currentSessionId = session.sessionId;
      const result = sessions.map(s => ({
        id: s.id,
        userAgent: s.userAgent,
        device: s.userAgent || 'Unknown device',
        ipAddress: s.ipAddress,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        lastSeenAt: s.lastUsedAt || s.createdAt,
        isCurrent: s.id === currentSessionId,
      }));
      if (!currentSessionId || currentSessionId === 'cli') {
        result.unshift({ id: 'cli', userAgent: 'Tirbeo CLI', device: 'Tirbeo CLI', ipAddress: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), lastSeenAt: new Date(), isCurrent: true });
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
      const targetSession = await prisma.session.findUnique({ where: { id: sessionId } });
      if (!targetSession || targetSession.userId !== session.userId) {
        return NextResponse.json({ error: 'Session not found' }, { status: 404 });
      }
      // Use deleteMany to be idempotent — session may already be revoked/deleted
      await prisma.session.deleteMany({ where: { id: sessionId, userId: session.userId } });
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
              FROM notifications
              WHERE user_id = ${session.userId}
            `,
            trackQuery('notifications_by_user_created', () => prisma.notification.findMany({
              where: { userId: session.userId },
              orderBy: { createdAt: 'desc' },
              take: limit,
              skip: offset,
              select: { id: true, type: true, title: true, body: true, link: true, icon: true, isRead: true, metadata: true, createdAt: true },
            })),
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

export async function notificationPrefsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    // Uses the shared DEFAULT_PREFS from lib/notifications (single source of
    // truth) — previously shadowed by a divergent inline copy (inApp, security,
    // quietHours keys, category emails defaulting ON) that drifted from the
    // preferences matrix the settings UI reads and writes.

    if (request.method === 'GET') {
      const user = await prisma.user.findUnique({ where: { id: session.userId },
        select: { notificationPreferences: true }
      });
      if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
      const prefs = { ...DEFAULT_PREFS, ...((user.notificationPreferences as any) || {}) };
      return NextResponse.json({ ok: true, ...prefs });
    }

    if (request.method === 'PUT') {
      const body: any = await request.json().catch(() => ({}));
      const ALLOWED = new Set(Object.keys(DEFAULT_PREFS));
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) if (ALLOWED.has(k)) filtered[k] = v;
      if (filtered.digestFrequency && !['daily','weekly','monthly'].includes(String(filtered.digestFrequency))) {
        return NextResponse.json({ error: 'Invalid digestFrequency' }, { status: 400 });
      }
      // Read existing prefs
      const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { notificationPreferences: true } });
      const existing = (user?.notificationPreferences as any) || {};
      // Merge incoming fields into the JSON column
      const merged = { ...DEFAULT_PREFS, ...existing, ...filtered };
      await prisma.user.update({ where: { id: session.userId }, data: { notificationPreferences: merged } });
      // clear email_unsubscribed flags when email re-enabled
      if (filtered.email === true) {
        await prisma.$executeRaw`UPDATE "users" SET "email_unsubscribed" = '{}'::jsonb WHERE "id" = ${session.userId}`.catch(()=>{});
      }
      return NextResponse.json({ ok: true, message: 'Notification preferences updated', ...merged });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[NOTIFICATION_PREFS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}

// ── Per-section prefs handlers — each section owns its API ──────────────────
// Channels: global email/push master
export async function notificationChannelsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const ALLOWED = new Set(['email','push']);
    const DEFAULTS = DEFAULT_PREFS;
    if (request.method === 'GET') {
      const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { notificationPreferences: true } });
      const prefs = { ...DEFAULT_PREFS, ...((user?.notificationPreferences as any) || {}) };
      return NextResponse.json({ ok: true, email: prefs.email, push: prefs.push });
    }
    if (request.method === 'PUT') {
      const body: any = await request.json().catch(()=>({}));
      const filtered: Record<string, unknown> = {};
      for (const k of Object.keys(body)) if (ALLOWED.has(k)) filtered[k] = body[k];
      const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { notificationPreferences: true } });
      const existing = (user?.notificationPreferences as any) || {};
      const merged = { ...existing, ...filtered };
      // fill defaults if missing
      for (const k of ALLOWED) if (merged[k] === undefined) merged[k] = (DEFAULTS as any)[k];
      await prisma.user.update({ where: { id: session.userId }, data: { notificationPreferences: merged as any } });
      if (filtered.email === true) await prisma.$executeRaw`UPDATE "users" SET "email_unsubscribed" = '{}'::jsonb WHERE "id" = ${session.userId}`.catch(()=>{});
      return NextResponse.json({ ok: true, ...merged });
    }
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (e:any) { return NextResponse.json({ error: 'Failed' }, { status: 500 }); }
}

// Categories: per-category master + per-channel sub-toggles
export async function notificationCategoriesHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const ALLOWED = new Set(['forms','product','support','tips','formsEmail','formsPush','productEmail','productPush','supportEmail','supportPush','tipsEmail','tipsPush']);
    const DEFAULTS = DEFAULT_PREFS;
    if (request.method === 'GET') {
      const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { notificationPreferences: true } });
      const prefs = { ...DEFAULTS, ...((user?.notificationPreferences as any) || {}) };
      const out: any = { ok: true }; for (const k of ALLOWED) out[k] = prefs[k];
      return NextResponse.json(out);
    }
    if (request.method === 'PUT') {
      const body: any = await request.json().catch(()=>({}));
      const filtered: Record<string, unknown> = {};
      for (const k of Object.keys(body)) if (ALLOWED.has(k)) filtered[k] = body[k];
      const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { notificationPreferences: true } });
      const existing = (user?.notificationPreferences as any) || {};
      const merged = { ...existing, ...filtered };
      await prisma.user.update({ where: { id: session.userId }, data: { notificationPreferences: merged as any } });
      return NextResponse.json({ ok: true, ...merged });
    }
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (e:any) { return NextResponse.json({ error: 'Failed' }, { status: 500 }); }
}

// Digest: enable + frequency
export async function notificationDigestHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const ALLOWED = new Set(['digestEnabled','digestFrequency','weeklySummary','weeklySummaryFrequency']);
    const DEFAULTS = DEFAULT_PREFS;
    if (request.method === 'GET') {
      const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { notificationPreferences: true } });
      const prefs = { ...DEFAULTS, ...((user?.notificationPreferences as any) || {}) };
      return NextResponse.json({ ok: true, digestEnabled: prefs.digestEnabled, digestFrequency: prefs.digestFrequency, weeklySummary: prefs.weeklySummary, weeklySummaryFrequency: prefs.weeklySummaryFrequency });
    }
    if (request.method === 'PUT') {
      const body: any = await request.json().catch(()=>({}));
      const filtered: Record<string, unknown> = {};
      for (const k of Object.keys(body)) if (ALLOWED.has(k)) filtered[k] = body[k];
      if (filtered.digestFrequency && !['daily','weekly','monthly'].includes(String(filtered.digestFrequency))) return NextResponse.json({ error: 'Invalid digestFrequency' }, { status: 400 });
      if (filtered.weeklySummaryFrequency && !['daily','weekly','monthly'].includes(String(filtered.weeklySummaryFrequency))) return NextResponse.json({ error: 'Invalid weeklySummaryFrequency' }, { status: 400 });
      const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { notificationPreferences: true } });
      const existing = (user?.notificationPreferences as any) || {};
      const merged = { ...existing, ...filtered };
      await prisma.user.update({ where: { id: session.userId }, data: { notificationPreferences: merged as any } });
      return NextResponse.json({ ok: true, ...merged });
    }
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (e:any) { return NextResponse.json({ error: 'Failed' }, { status: 500 }); }
}

// Tips: dedicated tips toggle (own API)
export async function notificationTipsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const ALLOWED = new Set(['tips','tipsEmail','tipsPush']);
    const DEFAULTS = DEFAULT_PREFS;
    if (request.method === 'GET') {
      const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { notificationPreferences: true } });
      const prefs = { ...DEFAULTS, ...((user?.notificationPreferences as any) || {}) };
      return NextResponse.json({ ok: true, tips: prefs.tips, tipsEmail: prefs.tipsEmail, tipsPush: prefs.tipsPush });
    }
    if (request.method === 'PUT') {
      const body: any = await request.json().catch(()=>({}));
      const filtered: Record<string, unknown> = {};
      for (const k of Object.keys(body)) if (ALLOWED.has(k)) filtered[k] = body[k];
      const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { notificationPreferences: true } });
      const existing = (user?.notificationPreferences as any) || {};
      const merged = { ...existing, ...filtered };
      await prisma.user.update({ where: { id: session.userId }, data: { notificationPreferences: merged as any } });
      return NextResponse.json({ ok: true, ...merged });
    }
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (e:any) { return NextResponse.json({ error: 'Failed' }, { status: 500 }); }
}

export async function oauthUnlinkHandler(request: NextRequest, provider: string) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const fieldMap: Record<string, 'googleId' | 'githubId' | 'discordId'> = {
      google: 'googleId',
      github: 'githubId',
      discord: 'discordId',
    };
    const field = fieldMap[provider];
    if (!field) return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 });

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, passwordHash: true, googleId: true, githubId: true, discordId: true },
    });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (!user[field]) return NextResponse.json({ error: 'This account is not linked' }, { status: 400 });

    const remaining = (['googleId', 'githubId', 'discordId'] as const)
      .filter((f) => f !== field && user[f]).length;
    if (!user.passwordHash && remaining === 0) {
      return NextResponse.json({ error: 'You must keep at least one sign-in method' }, { status: 400 });
    }

    await prisma.user.update({ where: { id: user.id }, data: { [field]: null } });

    createNotification({
      userId: user.id,
      type: 'security',
      title: 'Account disconnected',
      body: `Your ${provider} account was unlinked from Tirbeo. You can no longer sign in with it until you reconnect it.`,
      link: '/account/connected-apps',
    }).catch((e) => console.error('[NOTIFICATION]', e?.message));

    return NextResponse.json({ ok: true, message: `${provider} disconnected` });
  } catch (err: any) {
    console.error('[OAUTH UNLINK]', err?.message || err);
    return NextResponse.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }
}

export async function integrationsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const PROVIDERS: Record<string, 'googleId' | 'githubId' | 'discordId'> = {
      google: 'googleId', github: 'githubId', discord: 'discordId',
    };

    const readConnections = async () => {
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { googleId: true, githubId: true, discordId: true },
      });
      return Object.entries(PROVIDERS).map(([provider, field]) => ({
        id: `${session.userId}:${provider}`,
        provider,
        connected: !!((user as any)?.[field]),
      }));
    };

    if (request.method === 'GET') {
      return NextResponse.json(await readConnections());
    }

    const body: any = await request.json().catch(() => ({}));
    const provider = body?.provider || request.nextUrl.searchParams.get('provider');
    const field = PROVIDERS[provider];
    if (!field) return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 });

    if (request.method === 'DELETE') {
      // Disconnect: remove the sign-in link
      await prisma.user.update({ where: { id: session.userId }, data: { [field]: null } }).catch(() => {});
      createNotification({
        userId: session.userId,
        type: 'security',
        title: `${provider.charAt(0).toUpperCase() + provider.slice(1)} disconnected`,
        body: `Your ${provider} sign-in link was removed.`,
        link: '/account/connected-apps',
      }).catch((e) => console.error('[NOTIFICATION]', e?.message));
      return NextResponse.json({ ok: true, connections: await readConnections() });
    }

    if (request.method === 'POST') {
      // Connect: redirect to OAuth flow
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'https://api.tirbeo.app';
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

    // Transfer the OAuth provider ID from existing user to current user.
    // Never overwrite an existing name/photo — those are managed from the
    // dashboard profile; provider values only fill EMPTY fields.
    const providerField = `${provider}Id`;
    const currentUser = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, name: true, photoUrl: true },
    });
    if (!currentUser) {
      return NextResponse.json({ error: 'Current account not found' }, { status: 404 });
    }
    await prisma.user.update({
      where: { id: session.userId },
      data: {
        [providerField]: providerId,
        ...(currentUser.photoUrl ? {} : { photoUrl: photoUrl || undefined }),
        ...(currentUser.name ? {} : { name: name || undefined }),
      },
    });
    bustProfileCache(session.userId);



    // Audit log
    await prisma.auditEvent.create({
      data: {
        actorId: session.userId,
        action: 'account.merge',
        targetType: 'user',
        targetId: existingUserId,
        metadata: { provider, email, mergedFrom: existingUserId, mergedTo: session.userId },
        severity: 'warning',
      },
    }).catch(() => {});

    return NextResponse.json({ ok: true, action: 'merged', provider, email });
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
      trackQuery('audit_events_by_actor_created', () => prisma.auditEvent.findMany({
        where: { actorId: session.userId },
        orderBy: { createdAt: 'desc' },
        take: fetchLimit,
        select: { id: true, action: true, targetType: true, targetId: true, metadata: true, severity: true, createdAt: true },
      })),
      trackQuery('security_events_by_user_created', () => prisma.securityEvent.findMany({
        where: { userId: session.userId },
        orderBy: { createdAt: 'desc' },
        take: fetchLimit,
        select: { id: true, eventType: true, metadata: true, severity: true, createdAt: true },
      })),
      trackQuery('login_history_by_user_created', () => prisma.login_history.findMany({
        where: { userId: session.userId },
        orderBy: { createdAt: 'desc' },
        take: fetchLimit,
        select: { id: true, success: true, method: true, ipAddress: true, userAgent: true, metadata: true, createdAt: true },
      })),
      // Run all 3 count queries in parallel inside a single Promise.all
      Promise.all([
        trackQuery('activity_total_count', () => prisma.auditEvent.count({ where: { actorId: session.userId } })),
        trackQuery('activity_total_security', () => prisma.securityEvent.count({ where: { userId: session.userId } })),
        trackQuery('activity_total_login', () => prisma.login_history.count({ where: { userId: session.userId } })),
      ]),
    ]);

    // Merge into a single flat array sorted by date — dashboard expects this format
    const merged = [
      ...auditEvents.map(e => ({
        id: e.id, source: 'audit', action: e.action, targetType: e.targetType,
        targetId: e.targetId, metadata: e.metadata, severity: e.severity,
        createdAt: e.createdAt,
      })),
      ...securityEvents.map(e => ({
        id: e.id, source: 'security', action: e.eventType, targetType: null as string | null,
        targetId: null as string | null, metadata: e.metadata, severity: e.severity,
        createdAt: e.createdAt,
      })),
      ...loginHistoryRecords.map(e => ({
        id: e.id, source: 'login', action: e.success ? `auth.login_${e.method}_success` : 'auth.login_failed',
        targetType: 'session' as string | null, targetId: null as string | null,
        metadata: { ...((e.metadata as Record<string, any>) || {}), ip: e.ipAddress, userAgent: e.userAgent, method: e.method, success: e.success },
        severity: e.success ? ('info' as const) : ('warning' as const),
        createdAt: e.createdAt,
      })),
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
      formCount,
      openTickets,
      unreadNotifications,
      activeSessions,
      mediaAgg,
      integrations,
    ] = await Promise.all([
      trackQuery('apps_forms_count', () => prisma.form.count({ where: { userId } })),
      trackQuery('apps_tickets_open', () => prisma.ticket.count({ where: { customerId: userId, status: 'open' } })),
      trackQuery('apps_notif_unread', () => prisma.notification.count({ where: { userId, isRead: false } })),
      trackQuery('apps_sessions_active', () => prisma.session.count({ where: { userId, status: 'active' } })),
      trackQuery('apps_media_sum', () => prisma.media.aggregate({ where: { uploadedBy: userId }, _sum: { sizeBytes: true } })),
      trackQuery('apps_integrations', () => prisma.user.findUnique({
        where: { id: userId },
        select: { googleId: true, githubId: true, discordId: true },
      })),
    ]);

    const storageBytes = Number(mediaAgg._sum.sizeBytes ?? BigInt(0));
    const connectedIntegrations = ['google', 'github', 'discord'].filter((p) => !!(integrations as any)?.[`${p}Id`]).length;

    const formsUrl = process.env.NEXT_PUBLIC_FORMS_URL || 'https://forms.tirbeo.app';
    const apps = [
      {
        id: 'forms', name: 'Forms', title: 'Forms', subtitle: 'Forms & Surveys', index: '01',
        gradient: 'linear-gradient(135deg, #38bdf8 0%, #6366f1 100%)', blob1: '#7dd3fc', blob2: '#818cf8',
        live: true, href: formsUrl, count: formCount, connected: formCount > 0,
      },
      {
        id: 'collab', name: 'Collab', title: 'Collab', subtitle: 'Social Network', index: '02',
        gradient: 'linear-gradient(135deg, #f97316 0%, #ec4899 60%, #8b5cf6 100%)', blob1: '#fb923c', blob2: '#f472b6',
        live: false, href: null, count: 0, connected: false,
      },
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
        connectedIntegrations,
      },
    };
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
      openTickets,
      activeSessions,
      formsCount,
      mediaAgg,
      recentAudit,
      recentSecurity,
      recentLogin,
    ] = await Promise.all([
      trackQuery('overview_user', () => prisma.user.findUnique({ where: { id: userId } })),
      trackQuery('overview_notif_unread', () => prisma.notification.count({ where: { userId, isRead: false } })),
      trackQuery('overview_tickets_open', () => prisma.ticket.count({ where: { customerId: userId, status: 'open' } })),
      trackQuery('overview_sessions_active', () => prisma.session.count({ where: { userId, status: 'active' } })),
      trackQuery('overview_forms_count', () => prisma.form.count({ where: { userId } })),
      trackQuery('overview_media_sum', () => prisma.media.aggregate({ where: { uploadedBy: userId }, _sum: { sizeBytes: true } })),
      trackQuery('overview_recent_audit', () => prisma.auditEvent.findMany({
        where: { actorId: userId }, orderBy: { createdAt: 'desc' }, take: 6,
        select: { id: true, action: true, targetType: true, targetId: true, metadata: true, severity: true, createdAt: true },
      })),
      trackQuery('overview_recent_security', () => prisma.securityEvent.findMany({
        where: { userId }, orderBy: { createdAt: 'desc' }, take: 6,
        select: { id: true, eventType: true, metadata: true, severity: true, createdAt: true },
      })),
      trackQuery('overview_recent_login', () => prisma.login_history.findMany({
        where: { userId }, orderBy: { createdAt: 'desc' }, take: 6,
        select: { id: true, success: true, method: true, ipAddress: true, userAgent: true, metadata: true, createdAt: true },
      })),
    ]);

    const recentActivity = [
      ...recentAudit.map((e) => ({
        id: e.id, source: 'audit', action: e.action, targetType: e.targetType,
        targetId: e.targetId, metadata: e.metadata, severity: e.severity, createdAt: e.createdAt,
      })),
      ...recentSecurity.map((e) => ({
        id: e.id, source: 'security', action: e.eventType, targetType: null as string | null,
        targetId: null as string | null, metadata: e.metadata, severity: e.severity, createdAt: e.createdAt,
      })),
      ...recentLogin.map((e) => ({
        id: e.id, source: 'login', action: e.success ? `auth.login_${e.method}_success` : 'auth.login_failed',
        targetType: 'session' as string | null, targetId: null as string | null,
        metadata: { ...((e.metadata as Record<string, any>) || {}), ip: e.ipAddress, userAgent: e.userAgent, method: e.method, success: e.success },
        severity: e.success ? ('info' as const) : ('warning' as const),
        createdAt: e.createdAt,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 6);

    const storageBytes = Number(mediaAgg._sum.sizeBytes ?? BigInt(0));

    return NextResponse.json({
      overview: {
        unreadNotifications,
        openTickets,
        activeSessions,
        formsCount,
        storageBytes,
        storageLabel: storageBytes >= 1024 ** 3
          ? `${(storageBytes / 1024 ** 3).toFixed(1)} GB`
          : `${(storageBytes / 1024 ** 2).toFixed(1)} MB`,
        loginCount: (user as any)?.loginCount ?? 0,
        memberSince: (user as any)?.createdAt ?? null,
        lastActiveAt: (user as any)?.lastActiveAt ?? null,
      },
      recentActivity,
    });
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

    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    if (request.method === 'GET') {
      const consents: any = (user as any).consents ?? {};
      return NextResponse.json({
        ok: true,
        preferences: {
          theme: user.theme || 'system',
          language: user.language || 'en',
          timezone: user.timezone || 'UTC',
          privacy: {
            allowAnalytics: consents.allowAnalytics ?? false,
            allowCrashReports: consents.allowCrashReports ?? true,
          },
        },
      });
    }

    if (request.method === 'PATCH' || request.method === 'PUT') {
      const body: any = await request.json().catch(() => ({}));
      const update: Record<string, unknown> = {};
      if (body.theme) update.theme = body.theme;
      if (body.language) update.language = body.language;
      if (body.timezone) update.timezone = body.timezone;

      if (body.privacy && typeof body.privacy === 'object') {
        const currentConsents: any = (user as any).consents ?? {};
        const newConsents: Record<string, unknown> = { ...currentConsents };
        if (typeof body.privacy.allowAnalytics === 'boolean') newConsents.allowAnalytics = body.privacy.allowAnalytics;
        if (typeof body.privacy.allowCrashReports === 'boolean') newConsents.allowCrashReports = body.privacy.allowCrashReports;
        newConsents.updatedAt = new Date().toISOString();
        update.consents = newConsents;
        // Record consent change in audit log with full details
        prisma.auditEvent.create({
          data: {
            actorId: session.userId,
            action: 'consent.updated',
            targetType: 'user',
            targetId: session.userId,
            metadata: {
              privacy: body.privacy,
              previous: {
                allowAnalytics: currentConsents.allowAnalytics ?? null,
                allowCrashReports: currentConsents.allowCrashReports ?? null,
              },
              changedAt: new Date().toISOString(),
              changedFields: Object.keys(body.privacy).filter(k => typeof body.privacy[k] === 'boolean'),
            },
            severity: 'info',
            ipAddress: (request as any)?.headers?.get?.('x-forwarded-for')?.split(',')[0]?.trim() || (request as any)?.headers?.get?.('x-real-ip') || null,
            userAgent: (request as any)?.headers?.get?.('user-agent')?.slice(0, 200) || null,
          },
        }).catch(() => {});
      }

      await prisma.user.update({ where: { id: session.userId }, data: update });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[PREFERENCES]', err?.message || err);
    return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 });
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

    if (password.length > 128) {
      return NextResponse.json({ error: 'Password must be at most 128 characters' }, { status: 400 });
    }

    const hash = await hashPassword(password);
    await prisma.user.update({ where: { id: session.userId }, data: { passwordHash: hash, mustChangePassword: false } });

    return NextResponse.json({ ok: true, message: 'Password updated' });
  } catch (err: any) {
    console.error('[SET PASSWORD]', err?.message || err);
    return NextResponse.json({ error: 'Failed to set password' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// PROFILE EDIT OTP HANDLERS
// ═══════════════════════════════════════════════════════════════════
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
    await storeOtp(session.userId, `profile-edit:${field || 'general'}` as any, code);
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

    const valid = await verifyOtpCode(session.userId, `profile-edit:${field || 'general'}` as any, code);
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
        const ext = file.type.split('/')[1] || 'jpeg';
        const r2Key = `avatars/${session.userId}/${Date.now()}.${ext}`;
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
      if (url) photoUrl = url;
    }

    if (!photoUrl) return NextResponse.json({ error: 'No image provided' }, { status: 400 });

    await prisma.user.update({ where: { id: session.userId }, data: { photoUrl } });
    bustProfileCache(session.userId);

    createAuditEvent({
      actorId: session.userId,
      action: 'profile.avatar.updated',
      targetType: 'user',
      targetId: session.userId,
      metadata: { field: 'photoUrl', to: photoUrl },
      severity: 'info',
    }).catch((e) => console.error('[ACTIVITY]', e?.message));

    createNotification({
      userId: session.userId,
      type: 'system',
      title: 'Profile photo updated',
      body: `Your profile photo was updated.`,
      link: '/account/profile',
      metadata: { field: 'photoUrl' },
    }).catch((e) => console.error('[NOTIFICATION]', e?.message));

    return NextResponse.json({ ok: true, photoUrl });
  } catch (err: any) {
    console.error('[AVATAR UPLOAD]', err?.message || err);
    return NextResponse.json({ error: 'Failed to update avatar' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// HEARTBEAT HANDLER
// ═══════════════════════════════════════════════════════════════════
export async function heartbeatHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    await prisma.session.updateMany({
      where: { userId: session.userId, status: 'active' },
      data: { updatedAt: new Date() },
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPORT DATA HANDLER
// ═══════════════════════════════════════════════════════════════════
export async function exportDataHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    // Export ALL user data (excluding sensitive fields)
    const { passwordHash, totpSecret, backupCodes, ...userData } = user as any;
    const [
      sessions, auditEvents, securityEvents, loginHistory,
      notifications, emailLogs, tipLogs, media, tickets, ticketMessages,
      apiKeyCount, forms, formsSubmissions,
    ] = await Promise.all([
      prisma.session.findMany({ where: { userId: session.userId }, select: { id: true, userAgent: true, ipAddress: true, location: true, deviceName: true, createdAt: true, lastUsedAt: true, revokedAt: true } }).catch(() => []),
      prisma.auditEvent.findMany({ where: { actorId: session.userId }, select: { id: true, action: true, targetType: true, targetId: true, severity: true, metadata: true, createdAt: true } }).catch(() => []),
      prisma.securityEvent.findMany({ where: { userId: session.userId } }).catch(() => []),
      prisma.login_history.findMany({ where: { userId: session.userId } }).catch(() => []),
      prisma.notification.findMany({ where: { userId: session.userId }, select: { id: true, title: true, body: true, type: true, read: true, createdAt: true } }).catch(() => []),
      prisma.email_logs.findMany({ where: { toEmail: user.email }, take: 1000, select: { id: true, subject: true, templateName: true, status: true, createdAt: true } }).catch(() => []),
      prisma.userTipLog.findMany({ where: { userId: session.userId } }).catch(() => []),
      prisma.media.findMany({ where: { uploadedBy: session.userId }, select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true } }).catch(() => []),
      prisma.ticket.findMany({ where: { customerId: session.userId }, select: { id: true, subject: true, status: true, priority: true, createdAt: true } }).catch(() => []),
      prisma.ticketMessage.findMany({ where: { authorId: session.userId }, select: { id: true, body: true, createdAt: true } }).catch(() => []),
      prisma.apiKey.count({ where: { userId: session.userId } }).catch(() => 0),
      prisma.form.findMany({ where: { userId: session.userId }, select: { id: true, name: true, slug: true, createdAt: true } }).catch(() => []),
      prisma.formSubmission.count({ where: { form: { userId: session.userId } } }).catch(() => 0),
    ]);

    const exportData = {
      exportedAt: new Date().toISOString(),
      user: {
        id: userData.id,
        email: userData.email,
        name: userData.name,
        username: userData.username,
        role: userData.role,
        photoUrl: userData.photoUrl,
        bio: userData.bio,
        phone: userData.phone,
        country: userData.country,
        timezone: userData.timezone,
        language: userData.language,
        theme: userData.theme,
        dateFormat: userData.dateFormat,
        timeFormat: userData.timeFormat,
        createdAt: userData.createdAt,
        updatedAt: userData.updatedAt,
        lastActiveAt: userData.lastActiveAt,
        lastLoginAt: userData.lastLoginAt,
        loginCount: userData.loginCount,
        notificationPreferences: userData.notificationPreferences,
        consents: userData.consents,
        emailUnsubscribed: userData.emailUnsubscribed,
      },
      sessions,
      auditEvents,
      securityEvents,
      loginHistory,
      notifications,
      emailLogs,
      tipLogs,
      media,
      tickets,
      ticketMessages,
      forms,
      formsSubmissions,
      apiKeys: apiKeyCount,
    };

    // Send notification email — data has been downloaded, no link
    const { sendTemplateEmail } = await import('@/features/email/email');
    sendTemplateEmail(user.email, 'export_ready', {
      name: user.name || user.email,
      exportedAt: new Date().toLocaleString(),
    }).catch(() => {});

    // Return as downloadable JSON file
    const filename = `tirbeo-data-${user.username || user.email.split('@')[0]}-${new Date().toISOString().slice(0, 10)}.json`;
    return new NextResponse(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err: any) {
    console.error('[EXPORT DATA]', err?.message || err);
    return NextResponse.json({ error: 'Failed to export data' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// DELETE ACCOUNT REQUEST HANDLER (OTP-based)
// ═══════════════════════════════════════════════════════════════════
const recentDeleteMemo = new Map<string, { recentCreate: Date | null; ts: number }>();
export async function deleteAccountRequestHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const url = new URL(request.url);

    // DELETE ?cancel=1 → cancel scheduled deletion
    if (request.method === 'DELETE' || url.searchParams.get('cancel') === '1') {
      await prisma.$executeRaw`
        UPDATE "users" SET "scheduled_deletion_at" = NULL, "deletion_reason" = NULL
        WHERE "id" = ${session.userId}`;
      await prisma.session.updateMany({ where: { userId: session.userId, status: 'revoked' as any }, data: { status: 'active' as any } }).catch(() => {});
      try { const { bustProfileCache } = await import('@/features/auth/authHandlers'); bustProfileCache(session.userId); } catch {}
      await prisma.auditEvent.create({
        data: { actorId: session.userId, action: 'account.deletion-cancelled', targetType: 'user', targetId: session.userId, severity: 'info' },
      }).catch(() => {});
      return NextResponse.json({ ok: true, message: 'Deletion cancelled' });
    }

    const body = await request.json().catch(() => ({}));
    const { step, code, reason } = body as { step?: string; code?: string; reason?: string };

    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    if (user.scheduledDeletionAt) {
      return NextResponse.json({ error: 'Account deletion already scheduled', scheduledAt: user.scheduledDeletionAt }, { status: 409 });
    }

    // Step 1: Request OTP — send code to email. The once-per-week limit only
    // applies here (not to cancel/verify), and is memoized 60s so repeat
    // attempts don't pay another auditEvent query.
    if (!step || step === 'request') {
      const memo = recentDeleteMemo.get(session.userId);
      let recentDelete = memo?.recentCreate;
      if (!memo || Date.now() - memo.ts > 60_000) {
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        recentDelete = await prisma.auditEvent
          .findFirst({
            where: { actorId: session.userId, action: 'account.delete-request', createdAt: { gte: oneWeekAgo } },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          })
          .then((r) => r?.createdAt ?? null);
        recentDeleteMemo.set(session.userId, { recentCreate: recentDelete, ts: Date.now() });
      }
      if (recentDelete) {
        const nextAllowed = new Date(recentDelete.getTime() + 7 * 24 * 60 * 60 * 1000);
        const daysLeft = Math.ceil((nextAllowed.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
        return NextResponse.json({ error: `You can only request deletion once per week. Try again in ${daysLeft} day${daysLeft===1?'':'s'} (after ${nextAllowed.toLocaleDateString()}).` }, { status: 429 });
      }

      const { generateOtpCode, storeOtp } = await import('@/features/auth/otp');
      const { sendTemplateEmail } = await import('@/features/email/email');

      const otpCode = generateOtpCode();
      await storeOtp(session.userId, 'email', otpCode);

      sendTemplateEmail(user.email, 'delete_account_otp', {
        name: user.name || user.email,
        otp: otpCode,
      }).catch(() => {});

      return NextResponse.json({ ok: true, step: 'request', message: `Verification code sent to ${user.email}` });
    }

    // Step 2: Verify OTP → schedule deletion
    if (step === 'verify') {
      if (!code) return NextResponse.json({ error: 'Verification code is required' }, { status: 400 });

      const { verifyOtpCode } = await import('@/features/auth/otp');
      const valid = await verifyOtpCode(session.userId, 'email', code);
      if (!valid) return NextResponse.json({ error: 'Invalid or expired code' }, { status: 400 });

      const scheduledAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await prisma.$executeRaw`
        UPDATE "users" SET "scheduled_deletion_at" = ${scheduledAt}, "deletion_reason" = ${reason || null}
        WHERE "id" = ${session.userId}`;

      await prisma.session.updateMany({
        where: { userId: session.userId, id: { not: session.sessionId || '' }, status: 'active' as any },
        data: { status: 'revoked' as any, revokedAt: new Date() },
      }).catch(() => {});

      try { const { bustProfileCache } = await import('@/features/auth/authHandlers'); bustProfileCache(session.userId); } catch {}

      const { sendTemplateEmail } = await import('@/features/email/email');
      sendTemplateEmail(user.email, 'account_deleted', {
        name: user.name || user.email,
        dateLabel: scheduledAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
        dashboardUrl: (await import('@/config/app-urls')).getDashboardBaseUrl(),
      }).catch(() => {});

      await prisma.auditEvent.create({
        data: {
          actorId: session.userId,
          action: 'account.delete-request',
          targetType: 'user',
          targetId: session.userId,
          metadata: { reason, scheduledAt: scheduledAt.toISOString() },
          severity: 'critical',
        },
      }).catch(() => {});

      return NextResponse.json({ ok: true, step: 'verify', scheduledAt, message: 'Account scheduled for deletion in 30 days' });
    }

    return NextResponse.json({ error: 'Invalid step. Use "request" or "verify".' }, { status: 400 });
  } catch (err: any) {
    console.error('[DELETE ACCOUNT]', err?.message || err);
    return NextResponse.json({ error: 'Failed to process deletion request' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// PROCESS SCHEDULED DELETIONS (hard-delete past scheduledDeletionAt)
// ═══════════════════════════════════════════════════════════════════
export async function processScheduledDeletions(): Promise<{ deleted: number }> {
  const now = new Date();
  const expired = await prisma.user.findMany({
    where: { scheduledDeletionAt: { not: null, lte: now } },
    select: { id: true, email: true, name: true },
  });
  if (!expired.length) return { deleted: 0 };

  let deleted = 0;
  for (const u of expired) {
    try {
      // Set deletedAt first so proxy blocks immediately
      await prisma.user.update({
        where: { id: u.id },
        data: { deletedAt: now },
      }).catch(() => {});

      // Cascade-delete related data
      await prisma.session.deleteMany({ where: { userId: u.id } });
      await prisma.notification.deleteMany({ where: { userId: u.id } });
      await prisma.securityEvent.deleteMany({ where: { userId: u.id } });
      await prisma.login_history.deleteMany({ where: { userId: u.id } });
      await prisma.auditEvent.deleteMany({ where: { actorId: u.id } });
      await prisma.userTipLog.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.ticketMessage.deleteMany({ where: { authorId: u.id } }).catch(() => {});
      await prisma.ticket.updateMany({ where: { customerId: u.id }, data: { customerId: null as any } }).catch(() => {});
      await prisma.media.deleteMany({ where: { uploadedBy: u.id } }).catch(() => {});
      await prisma.apiKey.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.email_logs.deleteMany({ where: { toEmail: u.email } }).catch(() => {});
      await prisma.otp.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.blocklist.deleteMany({ where: { targetId: u.id } }).catch(() => {});

      // Hard-delete the user
      await prisma.user.delete({ where: { id: u.id } });
      deleted++;
      console.log(`[DELETION] Hard-deleted user ${u.id} (${u.email})`);
    } catch (err: any) {
      console.error(`[DELETION] Failed to hard-delete user ${u.id}:`, err?.message || err);
    }
  }
  return { deleted };
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC PROFILE HANDLER
// ═══════════════════════════════════════════════════════════════════
export async function publicProfileHandler(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId') || url.pathname.split('/').pop();

    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, username: true, photoUrl: true, createdAt: true },
    });

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    return NextResponse.json({ ok: true, profile: user });
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
      prisma.auditEvent.findMany({
        where: {
          actorId: session.userId,
          action: 'consent.updated',
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          action: true,
          metadata: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
        },
      }),
      prisma.auditEvent.count({
        where: {
          actorId: session.userId,
          action: 'consent.updated',
        },
      }),
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
          newValue: current[field] ?? null,
        })),
        previous,
        current,
      };
    });

    return NextResponse.json({
      events: formattedEvents,
      total,
      limit,
      offset,
    });
  } catch (err: any) {
    console.error('[CONSENT HISTORY]', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch consent history' }, { status: 500 });
  }
}
