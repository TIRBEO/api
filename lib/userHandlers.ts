import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { hashPassword, verifyPassword } from './auth/password';
import { generateOtpCode, storeOtp, verifyOtpCode, sendEmailOtp } from './auth/otp';
import { jsonUnauthorized } from './response';
import { sendTemplateEmail } from './email';
import { createNotification, describeDevice, fmtNow, getClientIpFromRequest } from './notifications';
import { sanitizeInput } from './security';
import { verifyMergeToken } from './auth/jwt';
import { bustProfileCache } from './authHandlers';
import { createTtlCache } from './cache';
import { logPerformance } from './perf';
import { trackQuery } from './queryMonitor';
import { logSecurityEvent } from './security';
import { withRetry } from './db/prisma';

// The dashboard polls notifications; short TTL keeps the poll cheap without
// making notifications feel stale.
const notificationsCache = createTtlCache<{ notifications: any[]; unread: number; total: number }>(5_000, 2000, 'notifications');

// Request deduplication: if multiple concurrent GET requests hit the same cache key,
// only one makes the actual DB query — the others wait and share the result.
const inFlightNotifications = new Map<string, Promise<{ notifications: any[]; unread: number; total: number }>>();

export function bustNotificationsCache(userId: string) {
  notificationsCache.clear();
  inFlightNotifications.clear();
}

// Cache for GET /api/preferences — dashboard polls this on every page load.
// 10s TTL: preferences rarely change, and bust on PATCH.
const preferencesCache = createTtlCache<any>(10_000, 2000, 'preferences');
function bustPreferencesCache(userId: string) { preferencesCache.delete(userId); }

// Cache for GET /api/user/activity — activity page polls this.
// 5s TTL: activity logs are append-only and stale data is acceptable.
const activityCache = createTtlCache<any[]>(5_000, 2000, 'activity');

// Cache for GET /api/profile/public — public profiles rarely change.
// 30s TTL: safe for public data, busts naturally.
const publicProfileCache = createTtlCache<any>(30_000, 2000, 'publicProfile');

// Debounce for POST /api/heartbeat — dashboard polls this every ~30s.
// Skip the DB write if we already updated within the last 25s.
const heartbeatDebounce = new Map<string, number>();
const HEARTBEAT_DEBOUNCE_MS = 25_000;

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

    if (request.method === 'PATCH') {
      const body: any = await request.json();
      const schema = z.object({
        name: z.string().min(1).optional(),
        username: z.string().optional().nullable(),
        photoUrl: z.string().optional().nullable(),
        phoneNumber: z.string().optional().nullable(),
        occupation: z.string().optional().nullable(),
        bio: z.string().optional().nullable(),
        website: z.string().url().optional().nullable(),
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
        secondaryEmail: z.string().email().optional().nullable(),
      });
      const parsed = schema.safeParse(body);
      if (!parsed.success) return new NextResponse('Invalid payload', { status: 400 });
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

      const changed = Object.keys(data).filter((k) => data[k] !== undefined && data[k] !== null);
      if (changed.some((k) => ['name', 'username', 'photoUrl'].includes(k))) {
        bustProfileCache(session.userId);
        createNotification({
          userId: session.userId,
          type: 'system',
          title: 'Profile updated',
          body: changed.includes('name')
            ? `Your display name was changed to "${updated.name ?? 'updated'}" on ${fmtNow()}.`
            : changed.includes('photoUrl')
              ? `Your profile photo was updated on ${fmtNow()}.`
              : `Your username was changed to "${updated.username ?? 'updated'}" on ${fmtNow()}.`,
          link: '/account/profile',
        }).catch((e) => console.error('[NOTIFICATION]', e?.message));
      }

      return NextResponse.json(updated);
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[EXTENDED PROFILE]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

export async function changePasswordHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body: any = await request.json();
    const { currentPassword, newPassword, otpCode } = body;
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return new NextResponse('Password must be at least 8 characters', { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, passwordHash: true } });
    if (!user) return new NextResponse('User not found', { status: 404 });

    if (user.passwordHash) {
      // User has a password — require currentPassword
      if (!currentPassword) {
        return new NextResponse('Current password required', { status: 400 });
      }
      if (!(await verifyPassword(user.passwordHash, currentPassword))) {
        return new NextResponse('Current password is incorrect', { status: 401 });
      }
    }
    // Passwordless (OAuth) account: email already verified by the provider —
    // no OTP or current password needed to set the first password.

    const { checkPasswordBreach } = await import('./auth/breach');
    const breach = await checkPasswordBreach(newPassword);
    if (breach.breached) {
      return new NextResponse('This password has been found in known breaches. Please choose a different password.', { status: 400 });
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
      body: `Your password was changed on ${fmtNow()} from ${loginDevice} (IP ${loginIp || 'unknown'}). All other sessions were signed out.`,
      link: '/account/security',
      metadata: { ip: loginIp, device: loginDevice, method: 'Password' },
    }).catch((e) => console.error('[NOTIFICATION]', (e as Error)?.message));

    // Event-triggered auto tip (only if productEmail enabled & tip unsent)
    import('./tips').then(m => m.sendNextTipForUser(session.userId)).catch(() => {});

    return new NextResponse('Password changed', { status: 200 });
  } catch (err: any) {
    console.error('[CHANGE PASSWORD]', err?.message || err);
    return new NextResponse('Failed to change password', { status: 500 });
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
      const body: any = await request.json();
      const { sessionId } = body;
      if (!sessionId) return new NextResponse('sessionId required', { status: 400 });
      if (sessionId === session.sessionId) return new NextResponse('Cannot terminate current session', { status: 400 });
      const targetSession = await prisma.session.findUnique({ where: { id: sessionId } });
      if (!targetSession || targetSession.userId !== session.userId) {
        return new NextResponse('Session not found', { status: 404 });
      }
      // Use deleteMany to be idempotent — session may already be revoked/deleted
      await prisma.session.deleteMany({ where: { id: sessionId, userId: session.userId } });
      return NextResponse.json({ ok: true, message: 'Session terminated' });
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[SESSIONS]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
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
          // Parallel queries for better performance with retry
          const [notifications, unread, total] = await Promise.all([
            withRetry(() => trackQuery('notifications_by_user_created', () => prisma.notification.findMany({
              where: { userId: session.userId },
              orderBy: { createdAt: 'desc' },
              take: limit,
              skip: offset,
              select: { id: true, type: true, title: true, body: true, link: true, icon: true, isRead: true, metadata: true, createdAt: true },
            }))),
            withRetry(() => trackQuery('notifications_by_user_read_count', () => prisma.notification.count({ where: { userId: session.userId, isRead: false } }))),
            withRetry(() => trackQuery('notifications_by_user_count', () => prisma.notification.count({ where: { userId: session.userId } }))),
          ]);
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
    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[NOTIFICATIONS]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

export async function notificationPrefsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    // Default notification preferences (all enabled)
    const DEFAULT_PREFS: Record<string, any> = {
      email: true, push: true, inApp: true,
      security: true, forms: true, product: true, support: true,
      quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '08:00',
      digestEnabled: false, digestFrequency: 'daily',
      securityEmail: true, securityPush: true, securityInApp: true,
      formsEmail: true, formsPush: true, formsInApp: true,
      productEmail: true, productPush: true, productInApp: true,
      supportEmail: true, supportPush: true, supportInApp: true,
      weeklySummary: false,
    };

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
      // Read existing prefs
      const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { notificationPreferences: true } });
      const existing = (user?.notificationPreferences as any) || {};
      // Merge incoming fields into the JSON column
      const merged = { ...DEFAULT_PREFS, ...existing, ...body };
      await prisma.user.update({ where: { id: session.userId }, data: { notificationPreferences: merged } });
      return NextResponse.json({ ok: true, message: 'Notification preferences updated', ...merged });
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[NOTIFICATION_PREFS]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
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
    if (!field) return new NextResponse('Unsupported provider', { status: 400 });

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, passwordHash: true, googleId: true, githubId: true, discordId: true },
    });
    if (!user) return new NextResponse('User not found', { status: 404 });
    if (!user[field]) return new NextResponse('This account is not linked', { status: 400 });

    const remaining = (['googleId', 'githubId', 'discordId'] as const)
      .filter((f) => f !== field && user[f]).length;
    if (!user.passwordHash && remaining === 0) {
      return new NextResponse('You must keep at least one sign-in method', { status: 400 });
    }

    await prisma.user.update({ where: { id: user.id }, data: { [field]: null } });

    createNotification({
      userId: user.id,
      type: 'security',
      title: 'Account disconnected',
      body: `Your ${provider} account was unlinked from Tirbeo on ${fmtNow()}. You can no longer sign in with it until you reconnect it.`,
      link: '/account/apps',
    }).catch((e) => console.error('[NOTIFICATION]', e?.message));

    return NextResponse.json({ ok: true, message: `${provider} disconnected` });
  } catch (err: any) {
    console.error('[OAUTH UNLINK]', err?.message || err);
    return new NextResponse('Failed to disconnect account', { status: 500 });
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
    if (!field) return new NextResponse('Unsupported provider', { status: 400 });

    if (request.method === 'DELETE') {
      // Disconnect: remove the sign-in link
      await prisma.user.update({ where: { id: session.userId }, data: { [field]: null } }).catch(() => {});
      createNotification({
        userId: session.userId,
        type: 'security',
        title: `${provider.charAt(0).toUpperCase() + provider.slice(1)} disconnected`,
        body: `Your ${provider} sign-in link was removed on ${fmtNow()}.`,
        link: '/account/apps',
      }).catch((e) => console.error('[NOTIFICATION]', e?.message));
      return NextResponse.json({ ok: true, connections: await readConnections() });
    }

    if (request.method === 'POST') {
      // Connect: redirect to OAuth flow
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'https://api.tirbeo.app';
      const redirectUrl = `${baseUrl}/api/auth/${provider}?link=1`;
      return NextResponse.json({ ok: true, redirectUrl });
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[INTEGRATIONS]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
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
    const offset = parseInt(url.searchParams.get('offset') || '0');

    // Fetch limit + offset to ensure we have enough for post-sort slicing
    // but cap at a sane maximum to prevent fetching unbounded data
    const fetchLimit = Math.min(limit + offset, 200);
    const [auditEvents, securityEvents] = await Promise.all([
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
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(offset, offset + limit);

    return NextResponse.json(merged);
  } catch (err: any) {
    console.error('[USER ACTIVITY]', err?.message || err);
    return NextResponse.json([]);
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
      return NextResponse.json({
        ok: true,
        preferences: {
          theme: user.theme || 'system',
          language: user.language || 'en',
          timezone: user.timezone || 'UTC',
        },
      });
    }

    if (request.method === 'PATCH' || request.method === 'PUT') {
      const body: any = await request.json().catch(() => ({}));
      const update: Record<string, unknown> = {};
      if (body.theme) update.theme = body.theme;
      if (body.language) update.language = body.language;
      if (body.timezone) update.timezone = body.timezone;

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
        const base64 = buffer.toString('base64');
        const ext = file.type.split('/')[1] || 'jpeg';
        photoUrl = `data:${file.type};base64,${base64}`;
      }
    } else {
      const body = await request.json().catch(() => ({}));
      const { url } = body as { url?: string };
      if (url) photoUrl = url;
    }

    if (!photoUrl) return NextResponse.json({ error: 'No image provided' }, { status: 400 });

    await prisma.user.update({ where: { id: session.userId }, data: { photoUrl } });
    bustProfileCache(session.userId);

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

    // Export user data (excluding sensitive fields)
    const { passwordHash, totpSecret, backupCodes, ...userData } = user as any;
    const [sessions, auditEvents, securityEvents, loginHistory, notifications] = await Promise.all([
      prisma.session.findMany({ where: { userId: session.userId } }),
      prisma.auditEvent.findMany({ where: { actorId: session.userId } }),
      prisma.securityEvent.findMany({ where: { userId: session.userId } }),
      prisma.login_history.findMany({ where: { userId: session.userId } }),
      prisma.notification.findMany({ where: { userId: session.userId } }),
    ]);

    return NextResponse.json({
      ok: true,
      export: {
        user: userData,
        sessions: sessions.map(s => ({ id: s.id, userAgent: s.userAgent, ip: s.ipAddress, createdAt: s.createdAt })),
        auditEvents,
        securityEvents,
        loginHistory,
        notifications: notifications.map(n => ({ title: n.title, message: n.body, type: n.type, createdAt: n.createdAt })),
      },
    });
  } catch (err: any) {
    console.error('[EXPORT DATA]', err?.message || err);
    return NextResponse.json({ error: 'Failed to export data' }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════
// DELETE ACCOUNT REQUEST HANDLER
// ═══════════════════════════════════════════════════════════════════
export async function deleteAccountRequestHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body = await request.json().catch(() => ({}));
    const { password, reason } = body as { password?: string; reason?: string };

    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    // If user has password, it must be provided for deletion
    if (user.passwordHash) {
      if (!password) return NextResponse.json({ error: 'Password is required to delete account' }, { status: 400 });
      const valid = await verifyPassword(user.passwordHash, password);
      if (!valid) return NextResponse.json({ error: 'Password is incorrect' }, { status: 400 });
    }

    // Send confirmation email
    const code = generateOtpCode();
    await storeOtp(session.userId, 'delete-account' as any, code);
    await sendEmailOtp(user.email, code);

    // Log the request
    await prisma.auditEvent.create({
      data: {
        actorId: session.userId,
        action: 'account.delete-request',
        targetType: 'user',
        targetId: session.userId,
        metadata: { reason },
        severity: 'critical',
      },
    }).catch(() => {});

    return NextResponse.json({ ok: true, message: 'Confirmation code sent to your email' });
  } catch (err: any) {
    console.error('[DELETE ACCOUNT]', err?.message || err);
    return NextResponse.json({ error: 'Failed to process deletion request' }, { status: 500 });
  }
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
