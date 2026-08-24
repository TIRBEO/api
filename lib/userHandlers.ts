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
import { isPushConfigured, getVapidPublicKey, subscribeToPush, unsubscribeFromPush, sendPushNotification } from './push-notifications';
import { createTtlCache } from './cache';
import { logPerformance } from './perf';
import { withRetry } from './db/prisma';

// The dashboard polls notifications; short TTL keeps the poll cheap without
// making notifications feel stale.
const notificationsCache = createTtlCache<{ notifications: any[]; unread: number; total: number }>(5_000, 2000, 'notifications');

// Request deduplication: if multiple concurrent GET requests hit the same cache key,
// only one makes the actual DB query — the others wait and share the result.
const inFlightNotifications = new Map<string, Promise<{ notifications: any[]; unread: number; total: number }>>();

function bustNotificationsCache(userId: string) {
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
           karmaPoints: true, lastLoginAt: true, lastLoginIp: true, loginCount: true, lastActiveAt: true,
           passwordHash: true, googleId: true, githubId: true, discordId: true,
           preferences: true,
         },
       });
      if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
      const { passwordHash, googleId, githubId, discordId, totpSecret, preferences: prefsJson, ...safe } = user;
      const prefs = (prefsJson as Record<string, any>) || {};
      const [recoveryCodesCount] = await Promise.all([
        prisma.recoveryCode.count({ where: { userId: session.userId } }),
      ]);
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
        skipPassword: !!prefs.skipPassword,
        phones: safe.phoneNumber ? [{ number: safe.phoneNumber, verified: safe.phoneVerified }] : [],
        lastPasswordChange: safe.updatedAt?.toISOString() || null,
      });
    }

    if (request.method === 'PATCH') {
      const body: any = await request.json();
      const schema = z.object({
        name: z.string().min(1).optional(),
        username: z.string().optional().nullable(),
        photoUrl: z.string().url().optional().nullable(),
        phoneNumber: z.string().optional().nullable(),
        occupation: z.string().optional().nullable(),
        bio: z.string().optional().nullable(),
        website: z.string().url().optional().nullable(),
        linkedin: z.string().optional().nullable(),
        github: z.string().optional().nullable(),
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
      if (raw.birthday) {
        data.birthday = typeof raw.birthday === 'string' ? new Date(raw.birthday) : raw.birthday;
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
    } else {
      // Passwordless (OAuth-only) user — require OTP
      if (!otpCode || typeof otpCode !== 'string') {
        return new NextResponse('Verification code required for passwordless accounts', { status: 400 });
      }
      const ok = await verifyOtpCode(session.userId, 'email', otpCode);
      if (!ok) return new NextResponse('Invalid or expired verification code', { status: 400 });
     }

    // Breach check runs in background — don't block password change
    const { checkPasswordBreach } = await import('./auth/breach');
    checkPasswordBreach(newPassword).then(breach => {
      if (breach.breached) {
        console.warn(`[SECURITY] User ${session.userId} set a breached password (${breach.count} hits)`);
      }
    }).catch(() => {});

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: session.userId }, data: { passwordHash: newHash } });
    await prisma.session.deleteMany({
      where: { userId: session.userId, NOT: { id: session.sessionId } },
    });

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

    // Event-triggered auto tip (only if tipsEmail enabled & tip unsent)
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
            withRetry(() => prisma.notification.findMany({
              where: { userId: session.userId },
              orderBy: { createdAt: 'desc' },
              take: limit,
              skip: offset,
              select: { id: true, type: true, title: true, body: true, link: true, icon: true, isRead: true, metadata: true, createdAt: true },
            })),
            withRetry(() => prisma.notification.count({ where: { userId: session.userId, isRead: false } })),
            withRetry(() => prisma.notification.count({ where: { userId: session.userId } })),
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
      const { notificationIds, markAll } = body;
      if (markAll) {
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
  const DEFAULT_PREFS = {
    userId: '', type: 'all',
    email: true, push: true, inApp: true,
    security: true, forms: true, product: true, support: true,
    securityEmail: true, securityPush: true, securityInApp: true,
    formsEmail: true, formsPush: true, formsInApp: true,
    productEmail: true, productPush: true, productInApp: true,
    supportEmail: true, supportPush: true, supportInApp: true,
    quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '08:00',
    digestEnabled: false, digestFrequency: 'daily',
    createdAt: new Date(), updatedAt: new Date(),
  };
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    if (request.method === 'GET') {
      let prefs: any = null;
      try {
        prefs = await prisma.notificationPreference.findUnique({ where: { userId: session.userId } });
      } catch (colErr: any) {
        // If columns are missing, try raw query with only base columns
        console.warn('[NOTIFICATIONS] Column error, falling back to base query:', colErr?.message?.slice(0, 100));
        try {
          const rows = await prisma.$queryRaw`SELECT * FROM notification_preferences WHERE user_id = ${session.userId} LIMIT 1`;
          prefs = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
        } catch { /* raw also fails — return defaults */ }
      }
      if (!prefs) {
        try {
          prefs = await prisma.notificationPreference.create({ data: { userId: session.userId } });
        } catch { prefs = { ...DEFAULT_PREFS, userId: session.userId }; }
      }
      return NextResponse.json(prefs);
    }

    if (request.method === 'PUT') {
      const body: any = await request.json();
      const allowed = [
        'type',
        // Global channels
        'email', 'push', 'inApp',
        // Category toggles
        'security', 'forms', 'product', 'support',
        // Per-category x channel matrix
        'securityEmail', 'securityPush', 'securityInApp',
        'formsEmail', 'formsPush', 'formsInApp',
        'productEmail', 'productPush', 'productInApp',
        'supportEmail', 'supportPush', 'supportInApp',
        // Quiet hours
        'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd',
        // Digest
        'digestEnabled', 'digestFrequency',
        // Email preferences card
        'tipsEmail', 'weeklySummary',
      ];
      const data: Record<string, any> = {};
      for (const key of allowed) {
        if (body[key] !== undefined) data[key] = body[key];
      }
      try {
        await prisma.notificationPreference.upsert({
          where: { userId: session.userId },
          create: { userId: session.userId, ...data },
          update: data,
        });
      } catch (upsertErr: any) {
        // If new columns missing, strip them and retry
        console.warn('[NOTIFICATIONS] Upsert error, retrying with base columns:', upsertErr?.message?.slice(0, 100));
        const baseKeys = ['type', 'email', 'push', 'inApp', 'security', 'forms', 'product', 'support'];
        const baseData: Record<string, any> = {};
        for (const k of baseKeys) { if (data[k] !== undefined) baseData[k] = data[k]; }
        try {
          await prisma.notificationPreference.upsert({
            where: { userId: session.userId },
            create: { userId: session.userId, ...baseData },
            update: baseData,
          });
        } catch { /* give up gracefully */ }
      }
      return NextResponse.json({ ok: true, message: 'Notification preferences updated' });
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[NOTIFICATION_PREFS]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

export async function pushSubscriptionHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    if (request.method === 'GET') {
      if (!isPushConfigured()) {
        return NextResponse.json({ error: { code: 'PUSH_NOT_CONFIGURED', message: 'Push notifications are not configured.' } }, { status: 400 });
      }
      return NextResponse.json({ publicKey: getVapidPublicKey() });
    }

    if (request.method === 'POST') {
      const body: any = await request.json();
      const { endpoint, p256dh, auth } = body;
      if (!endpoint || !p256dh || !auth) {
        return new NextResponse('Invalid push subscription', { status: 400 });
      }
      await subscribeToPush(session.userId, { endpoint, p256dh, auth }, request.headers.get('user-agent') || undefined);
      return NextResponse.json({ ok: true, message: 'Subscribed' });
    }

    if (request.method === 'DELETE') {
      const body: any = await request.json().catch(() => ({}));
      const endpoint = body?.endpoint;
      if (!endpoint) return new NextResponse('endpoint required', { status: 400 });
      await unsubscribeFromPush(session.userId, endpoint);
      return NextResponse.json({ ok: true, message: 'Unsubscribed' });
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[PUSH SUBSCRIBE]', err?.message || err);
    return new NextResponse('Failed to update push subscription', { status: 500 });
  }
}

export async function sendTestPushHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    if (!isPushConfigured()) {
      return new NextResponse('Push notifications are not configured', { status: 400 });
    }
    const result = await sendPushNotification(session.userId, {
      title: 'Test notification',
      body: 'This is a test push notification from Tirbeo.',
      url: '/account/inbox',
    });
    if (result.sent === 0) {
      return new NextResponse('You have no active push subscriptions', { status: 400 });
    }
    return NextResponse.json({ message: `Test sent to ${result.sent} device(s)` });
  } catch (err: any) {
    console.error('[PUSH SEND]', err?.message || err);
    return new NextResponse('Failed to send test notification', { status: 500 });
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

    // Full reset — remove the integration record so re-connecting starts clean.
    await prisma.integration.deleteMany({ where: { userId: user.id, provider } }).catch(() => {});

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

    if (request.method === 'GET') {
      const integrations = await prisma.integration.findMany({
        where: { userId: session.userId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, provider: true, connected: true, createdAt: true, updatedAt: true },
      });
      return NextResponse.json(integrations);
    }

    if (request.method === 'POST') {
      const body: any = await request.json();
      const { provider, connected } = body;
      if (!provider) return new NextResponse('provider required', { status: 400 });

      // Disconnect semantics: remove everything — no lingering rows.
      if (connected === false) {
        const fieldMap: Record<string, 'googleId' | 'githubId' | 'discordId'> = { google: 'googleId', github: 'githubId', discord: 'discordId' };
        if (fieldMap[provider]) {
          await prisma.user.update({ where: { id: session.userId }, data: { [fieldMap[provider]]: null } }).catch(() => {});
        }
        await prisma.integration.deleteMany({ where: { userId: session.userId, provider } });
        return NextResponse.json({ ok: true, message: `${provider} disconnected` });
      }

      const integration = await prisma.integration.upsert({
        where: { userId_provider: { userId: session.userId, provider } },
        update: { connected: connected ?? true },
        create: { userId: session.userId, provider, connected: connected ?? true },
      });
      if (integration.connected) {
        createNotification({
          userId: session.userId,
          type: 'security',
          title: `${provider.charAt(0).toUpperCase() + provider.slice(1)} connected`,
          body: `Your ${provider} account is now linked and active on Tirbeo (connected on ${fmtNow()}).`,
          link: '/account/apps',
        }).catch((e) => console.error('[NOTIFICATION]', e?.message));
      }
      return NextResponse.json(integration);
    }

    if (request.method === 'DELETE') {
      const body: any = await request.json();
      const { provider } = body;
      if (!provider) return new NextResponse('provider required', { status: 400 });
      // Sync rule: removing the integration also clears the sign-in link.
      const fieldMap: Record<string, 'googleId' | 'githubId' | 'discordId'> = { google: 'googleId', github: 'githubId', discord: 'discordId' };
      if (fieldMap[provider]) {
        await prisma.user.update({ where: { id: session.userId }, data: { [fieldMap[provider]]: null } }).catch(() => {});
      }
      await prisma.integration.deleteMany({ where: { userId: session.userId, provider } });
      return new NextResponse('Integration removed', { status: 200 });
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[INTEGRATIONS]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

export async function userActivityHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get('limit')) || 50, 1), 100);
    const cacheKey = `act2:${session.userId}:${limit}`;
    const cached = activityCache.get(cacheKey);
    if (cached) return NextResponse.json(cached);

    const [audits, security] = await Promise.all([
      prisma.auditEvent.findMany({
        where: { actorId: session.userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, action: true, targetType: true, targetId: true, metadata: true, severity: true, createdAt: true },
      }),
      prisma.securityEvent.findMany({
        where: { userId: session.userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, eventType: true, severity: true, ipAddress: true, userAgent: true, metadata: true, createdAt: true },
      }),
    ]);

    const items = [
      ...audits.map((a: any) => ({
        id: a.id,
        source: 'audit',
        action: a.action,
        targetType: a.targetType,
        targetId: a.targetId,
        metadata: a.metadata || {},
        severity: a.severity,
        createdAt: a.createdAt,
      })),
      ...security.map((s: any) => ({
        id: `sec-${s.id}`,
        source: 'security',
        action: s.eventType,
        targetType: 'security',
        targetId: null,
        metadata: {
          ...(typeof s.metadata === 'object' && s.metadata !== null ? s.metadata : {}),
          ip: s.ipAddress || undefined,
          userAgent: s.userAgent || undefined,
        },
        severity: s.severity,
        createdAt: s.createdAt,
      })),
    ]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    activityCache.set(cacheKey, items);
    return NextResponse.json(items);
  } catch (err: any) {
    console.error('[USER ACTIVITY]', err?.message || err);
    return new NextResponse('Failed to fetch activity', { status: 500 });
  }
}

export async function preferencesHandler(request: NextRequest) {
  const startTime = performance.now();
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    if (request.method === 'GET') {
      // Check in-memory cache first
      const cached = preferencesCache.get(session.userId);
      if (cached) return NextResponse.json(cached);

      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: {
          theme: true, language: true, timezone: true, dateFormat: true,
          timeFormat: true, preferences: true,
        },
      });
      const prefs = (user?.preferences as Record<string, any>) || {};
      const result = {
        ...user,
        privacy: prefs.privacy || {
          showEmail: false, showPhone: false, showLocation: true, showOnlineStatus: true,
          showActivityStatus: true, allowReadReceipts: true, showLastActive: true,
          allowAnalytics: false, allowCrashReports: true, personalizedRecommendations: false,
          allowSearchEngines: true, showInDirectory: true,
        },
        weekStart: prefs.weekStart || null,
        currency: prefs.currency || null,
        defaultLanding: prefs.defaultLanding || null,
        themeId: prefs.themeId || null,
        accentColor: prefs.accentColor || null,
      };
      preferencesCache.set(session.userId, result);
      return NextResponse.json(result);
    }

    if (request.method === 'PATCH') {
      const body: any = await request.json();
      const bodyStr = JSON.stringify(body);
      if (bodyStr.length > 10240) return new NextResponse('Payload too large (max 10KB)', { status: 413 });
      const schema = z.object({
        theme: z.enum(['light', 'dark', 'system']).optional(),
        language: z.string().optional(),
        timezone: z.string().optional(),
        dateFormat: z.string().optional(),
        timeFormat: z.string().optional(),

        preferences: z.any().optional(),
        weekStart: z.string().optional(),
        currency: z.string().optional(),
        defaultLanding: z.string().optional(),
        themeId: z.string().nullable().optional(),
        accentColor: z.string().nullable().optional(),
      });
      const parsed = schema.safeParse(body);
      if (!parsed.success) return new NextResponse('Invalid payload', { status: 400 });
      const data: Record<string, any> = { ...parsed.data };
      const extraKeys = ['weekStart', 'currency', 'defaultLanding', 'themeId', 'accentColor'];
      const existingPrefs = (await prisma.user.findUnique({ where: { id: session.userId }, select: { preferences: true } }))?.preferences as Record<string, any> || {};
      for (const key of extraKeys) {
        if (data[key] !== undefined) {
          data.preferences = { ...existingPrefs, ...data.preferences, [key]: data[key] };
          delete data[key];
        }
      }
      if (data.preferences && typeof data.preferences === 'object') {
        // Deep merge privacy specifically
        if (data.preferences.privacy && typeof data.preferences.privacy === 'object') {
          const existingPrivacy = (existingPrefs.privacy as Record<string, any>) || {};
          data.preferences = {
            ...existingPrefs,
            ...data.preferences,
            privacy: { ...existingPrivacy, ...data.preferences.privacy },
          };
        } else {
          data.preferences = { ...existingPrefs, ...data.preferences };
        }
      }
      await prisma.user.update({ where: { id: session.userId }, data });
      bustPreferencesCache(session.userId);
      bustNotificationsCache(session.userId);
      return NextResponse.json({ ok: true, message: 'Preferences updated' });
    }

    logPerformance('preferences', startTime);
    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[PREFERENCES]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

// POST /api/security/set-password — OAuth users can set a password after verifying via OTP
export async function setPasswordHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body: any = await request.json();
    const { password, otpCode } = body;
    if (!password || typeof password !== 'string' || password.length < 8) {
      return new NextResponse('Password must be at least 8 characters', { status: 400 });
    }
    if (!otpCode || typeof otpCode !== 'string') {
      return new NextResponse('OTP code required', { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true } });
    if (!user) return new NextResponse('User not found', { status: 404 });

    const ok = await verifyOtpCode(session.userId, 'email', otpCode);
    if (!ok) return new NextResponse('Invalid or expired verification code', { status: 400 });

    const hash = await hashPassword(password);
    await prisma.user.update({ where: { id: session.userId }, data: { passwordHash: hash } });
    return new NextResponse('Password set successfully', { status: 200 });
  } catch (err: any) {
    console.error('[SET PASSWORD]', err?.message || err);
    return new NextResponse('Failed to set password', { status: 500 });
  }
}

export async function heartbeatHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (session?.userId) {
      // Debounce: skip DB write if we already updated within the last 25s
      const lastUpdate = heartbeatDebounce.get(session.userId) || 0;
      if (Date.now() - lastUpdate < HEARTBEAT_DEBOUNCE_MS) {
        return NextResponse.json({ ok: true });
      }
      heartbeatDebounce.set(session.userId, Date.now());
      // Prune old entries periodically
      if (heartbeatDebounce.size > 2000) {
        const now = Date.now();
        for (const [k, v] of heartbeatDebounce) {
          if (now - v > HEARTBEAT_DEBOUNCE_MS) heartbeatDebounce.delete(k);
        }
      }
      // Fire-and-forget: don't block the response
      prisma.user.update({
        where: { id: session.userId },
        data: { lastActiveAt: new Date() },
      }).catch(() => {});
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[HEARTBEAT]', err?.message || err);
    return NextResponse.json({ ok: true });
  }
}

// POST /api/profile/request-edit-otp — send OTP before sensitive profile edits
export async function requestProfileEditOtpHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, email: true } });
    if (!user?.email) return new NextResponse('No email on file', { status: 400 });

    const code = generateOtpCode();
    await storeOtp(session.userId, 'email', code);
    try {
      await sendEmailOtp(user.email, code);
    } catch (err) {
      console.error('[PROFILE EDIT OTP] Email send failed, but OTP stored:', err);
    }
    return new NextResponse('Verification code sent', { status: 200 });
  } catch (err: any) {
    console.error('[PROFILE EDIT OTP REQUEST]', err?.message || err);
    return new NextResponse('Failed to send verification code', { status: 500 });
  }
}

// POST /api/profile/verify-edit-otp — verify OTP for sensitive profile edit
export async function verifyProfileEditOtpHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const { code } = (await request.json()) as any;
    if (typeof code !== 'string') return new NextResponse('Invalid payload', { status: 400 });

    const ok = await verifyOtpCode(session.userId, 'email', code);
    if (!ok) return new NextResponse('Invalid or expired verification code', { status: 400 });

    return NextResponse.json({ verified: true, message: 'Profile edit authorized' });
  } catch (err: any) {
    console.error('[PROFILE EDIT OTP VERIFY]', err?.message || err);
    return new NextResponse('Failed to verify code', { status: 500 });
  }
}

// POST /api/profile/avatar — upload avatar image
export async function avatarUploadHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const formData = await request.formData();
    const file = formData.get('avatar') as File | null;
    if (!file) return new NextResponse('No file uploaded', { status: 400 });

    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.type)) return new NextResponse('Invalid file type. Allowed: JPEG, PNG, WebP, GIF', { status: 400 });
    if (file.size > 5 * 1024 * 1024) return new NextResponse('File too large. Max 5MB', { status: 400 });

    const ext = file.name.split('.').pop() || 'jpg';
    const fileName = `avatar-${session.userId}-${Date.now()}.${ext}`;

    const { storeMediaFile } = await import('./mediaStorage');
    const { url: photoUrl } = await storeMediaFile({
      key: `avatars/${fileName}`,
      body: Buffer.from(await file.arrayBuffer()),
      contentType: file.type,
    });

    await prisma.user.update({
      where: { id: session.userId },
      data: { photoUrl },
    });
    // Header/sidebar read the 10s-cached /users/me — bust it so the new
    // picture shows immediately on next navigation/poll.
    bustProfileCache(session.userId);

    createNotification({
      userId: session.userId,
      type: 'system',
      title: 'Profile photo updated',
      body: `Your profile photo was changed on ${fmtNow()}. It now appears across the dashboard, header and sidebar.`,
      link: '/account/profile',
    }).catch((e) => console.error('[NOTIFICATION]', e?.message));

    return NextResponse.json({ photoUrl, message: 'Avatar updated' });
  } catch (err: any) {
    console.error('[AVATAR UPLOAD]', err?.message || err);
    return new NextResponse('Failed to upload avatar', { status: 500 });
  }
}



export async function exportDataHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    if (request.method !== 'GET' && request.method !== 'POST') return new NextResponse('Method not allowed', { status: 405 });

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true, email: true, name: true, photoUrl: true,
        phoneNumber: true, occupation: true, bio: true,
        secondaryEmail: true, gender: true, birthday: true,
        website: true, linkedin: true, githubUsername: true, twitter: true,
        country: true, timezone: true, language: true, theme: true,
        dateFormat: true, timeFormat: true,
        companyName: true, companyRole: true, industry: true, companySize: true,
        adminRole: true, is2FAEnabled: true,
        createdAt: true, updatedAt: true,
        preferences: true,
      },
    });
    if (!user) return new NextResponse('User not found', { status: 404 });

    const sessions = await prisma.session.findMany({
      where: { userId: session.userId },
      select: { id: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const auditLogs = await prisma.auditEvent.findMany({
      where: { actorId: session.userId },
      select: { action: true, createdAt: true, ipAddress: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const notifications = await prisma.notification.findMany({
      where: { userId: session.userId },
      select: { title: true, body: true, isRead: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const exportData = {
      exportedAt: new Date().toISOString(),
      profile: user,
      sessions,
      auditLogs,
      notifications,
      preferences: user.preferences,
    };

    const url = new URL(request.url);
    // GET ?download=1 — return the archive as a downloadable attachment.
    if (request.method === 'GET' && url.searchParams.get('download') === '1') {
      return new NextResponse(JSON.stringify(exportData, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="tirbeo-export-${new Date().toISOString().slice(0, 10)}.json"`,
        },
      });
    }

    // GET (no param) — inline JSON for direct API access.
    if (request.method === 'GET') {
      return NextResponse.json(exportData);
    }

    // POST — prepare the archive, notify the user and email the download link.
    const origin = `${url.protocol}//${url.host}`;
    const downloadUrl = `${origin}/api/user/export-data?download=1`;

    Promise.allSettled([
      createNotification({
        userId: session.userId,
        type: 'system',
        title: 'Data export ready',
        body: `Your data archive was prepared on ${fmtNow()}. Download it from Privacy settings — the link also works from the email we sent you.`,
        link: '/account/privacy',
      }),
      sendTemplateEmail(user.email, 'export_ready', {
        name: user.name || 'there',
        exportedAt: new Date().toLocaleString(),
        downloadUrl,
      }),
    ]);

    await prisma.auditEvent.create({
      data: {
        actorId: session.userId,
        action: 'DATA_EXPORT_REQUESTED',
        ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown',
        userAgent: request.headers.get('user-agent') || 'unknown',
        metadata: { requestedAt: new Date().toISOString() },
      },
    });

    return NextResponse.json({
      ok: true,
      message: 'Your data export is being prepared. You will receive an email when it is ready.',
      downloadUrl,
    });
  } catch (err: any) {
    console.error('[EXPORT]', err?.message || err);
    return new NextResponse('Failed to export data', { status: 500 });
  }
}

export async function deleteAccountRequestHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    if (request.method !== 'POST') return new NextResponse('Method not allowed', { status: 405 });

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { email: true, name: true },
    });
    if (!user) return new NextResponse('User not found', { status: 404 });

    await prisma.auditEvent.create({
      data: {
        actorId: session.userId,
        action: 'DELETE_ACCOUNT_REQUEST',
        ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown',
        userAgent: request.headers.get('user-agent') || 'unknown',
        metadata: { email: user.email, name: user.name, requestedAt: new Date().toISOString() },
      },
    });

    return NextResponse.json({
      ok: true,
      message: 'Deletion request submitted. Contact support@tirbeo.app to finalize.',
    });
  } catch (err: any) {
    console.error('[DELETE_ACCOUNT]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

export async function publicProfileHandler(request: NextRequest) {
  try {
    if (request.method !== 'GET') return new NextResponse('Method not allowed', { status: 405 });

    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    if (!userId) return new NextResponse('userId required', { status: 400 });

    // Check cache first (public profiles rarely change)
    const cached = publicProfileCache.get(userId);
    if (cached) return NextResponse.json(cached);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, name: true, email: true, photoUrl: true, bio: true, occupation: true,
        country: true, createdAt: true, lastActiveAt: true,
        isVerified: true, karmaPoints: true,
        preferences: true,
      },
    });
    if (!user) return new NextResponse('User not found', { status: 404 });

    const prefs = (user.preferences as Record<string, any>) || {};
    const privacy = prefs.privacy || {};

    const profile: Record<string, any> = { id: user.id, name: user.name, photoUrl: user.photoUrl };
    if (privacy.showEmail !== false) profile.email = user.email;

    if (privacy.showLocation !== false) profile.country = user.country;
    if (privacy.showOnlineStatus !== false) profile.isOnline = user.lastActiveAt && (Date.now() - new Date(user.lastActiveAt).getTime()) < 300000;
    if (privacy.showLastActive !== false) profile.lastActiveAt = user.lastActiveAt;
    if (privacy.showActivityStatus !== false) profile.bio = user.bio;
    if (privacy.showOccupation !== false) profile.occupation = user.occupation;
    profile.createdAt = user.createdAt;
    profile.isVerified = user.isVerified;
    profile.karmaPoints = user.karmaPoints;

    publicProfileCache.set(userId, profile);
    return NextResponse.json(profile);
  } catch (err: any) {
    console.error('[PUBLIC_PROFILE]', err?.message || err);
    return new NextResponse('Failed to fetch profile', { status: 500 });
  }
}

/**
 * POST /integrations/merge — Merge an OAuth provider account into the current user.
 * Body: { merge_token: string, action: 'merge' | 'cancel' }
 */
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

    // Set the provider ID on the current user
    await prisma.user.update({
      where: { id: session.userId },
      data: {
        [providerField]: providerId,
        photoUrl: photoUrl || undefined,
        name: name || undefined,
      },
    });

    // Create integration for current user
    await prisma.integration.upsert({
      where: { userId_provider: { userId: session.userId, provider } },
      update: { connected: true, metadata: { [`${provider}Id`]: providerId, email } },
      create: { userId: session.userId, provider, connected: true, metadata: { [`${provider}Id`]: providerId, email } },
    });

    // Remove integration from existing user if any
    await prisma.integration.deleteMany({
      where: { userId: existingUserId, provider },
    }).catch(() => {});

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
