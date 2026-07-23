import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { hashPassword, verifyPassword } from './auth/password';
import { generateOtpCode, storeOtp, verifyOtpCode, sendEmailOtp } from './auth/otp';

export async function extendedProfileHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    if (request.method === 'GET') {
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: {
          id: true, email: true, name: true, photoUrl: true,
          phoneNumber: true, occupation: true, bio: true,
          website: true, linkedin: true, github: true, twitter: true,
          country: true, timezone: true, language: true, theme: true,
          dateFormat: true, timeFormat: true, fontSize: true,
          reduceMotion: true, highContrast: true,
          emailVerified: true, phoneVerified: true, is2FAEnabled: true,
          companyName: true, companyRole: true, industry: true, companySize: true,
          gender: true, birthday: true,
          createdAt: true, updatedAt: true,
          passwordHash: true, googleId: true, githubId: true,
        },
      });
      if (!user) return new NextResponse('User not found', { status: 404 });
      const { passwordHash, googleId, githubId, ...safe } = user;
      return NextResponse.json({
        ...safe,
        hasPassword: !!passwordHash,
        hasGoogle: !!googleId,
        hasGithub: !!githubId,
      });
    }

    if (request.method === 'PATCH') {
      const body = await request.json();
      const schema = z.object({
        name: z.string().min(1).optional(),
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
        fontSize: z.string().optional().nullable(),
        reduceMotion: z.boolean().optional(),
        highContrast: z.boolean().optional(),
        companyName: z.string().optional().nullable(),
        companyRole: z.string().optional().nullable(),
        industry: z.string().optional().nullable(),
        companySize: z.string().optional().nullable(),
        gender: z.string().optional().nullable(),
        birthday: z.string().optional().nullable(),
      });
      const parsed = schema.safeParse(body);
      if (!parsed.success) return new NextResponse('Invalid payload', { status: 400 });
      const data: any = { ...parsed.data };
      if (data.birthday && typeof data.birthday === 'string') {
        data.birthday = new Date(data.birthday);
      }
      const updated = await prisma.user.update({
        where: { id: session.userId },
        data,
        select: {
          id: true, email: true, name: true, photoUrl: true,
          phoneNumber: true, occupation: true, bio: true,
          website: true, linkedin: true, github: true, twitter: true,
          country: true, timezone: true, language: true, theme: true,
          dateFormat: true, timeFormat: true, fontSize: true,
          reduceMotion: true, highContrast: true,
          companyName: true, companyRole: true, industry: true, companySize: true,
          gender: true, birthday: true,
          emailVerified: true, phoneVerified: true, is2FAEnabled: true,
          createdAt: true, updatedAt: true,
        },
      });
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
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    const body = await request.json();
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

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: session.userId }, data: { passwordHash: newHash } });
    await prisma.session.deleteMany({
      where: { userId: session.userId, NOT: { id: session.sessionId } },
    });
    return new NextResponse('Password changed', { status: 200 });
  } catch (err: any) {
    console.error('[CHANGE PASSWORD]', err?.message || err);
    return new NextResponse('Failed to change password', { status: 500 });
  }
}

export async function sessionsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    if (request.method === 'GET') {
      const sessions = await prisma.session.findMany({
        where: { userId: session.userId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true, lastUsedAt: true },
      });
      return NextResponse.json(sessions);
    }

    if (request.method === 'DELETE') {
      const body = await request.json();
      const { sessionId } = body;
      if (!sessionId) return new NextResponse('sessionId required', { status: 400 });
      if (sessionId === session.sessionId) return new NextResponse('Cannot terminate current session', { status: 400 });
      const targetSession = await prisma.session.findUnique({ where: { id: sessionId } });
      if (!targetSession || targetSession.userId !== session.userId) {
        return new NextResponse('Session not found', { status: 404 });
      }
      await prisma.session.delete({ where: { id: sessionId } });
      return new NextResponse('Session terminated', { status: 200 });
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[SESSIONS]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

export async function notificationsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    if (request.method === 'GET') {
      const limit = Number(request.nextUrl.searchParams.get('limit')) || 20;
      const notifications = await prisma.notification.findMany({
        where: { userId: session.userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, type: true, title: true, body: true, link: true, icon: true, priority: true, read: true, readAt: true, createdAt: true },
      });
      const unread = await prisma.notification.count({ where: { userId: session.userId, read: false } });
      return NextResponse.json({ notifications, unread });
    }

    if (request.method === 'PATCH') {
      const body = await request.json();
      const { notificationIds, markAll } = body;
      if (markAll) {
        await prisma.notification.updateMany({ where: { userId: session.userId, read: false }, data: { read: true } });
      } else if (notificationIds && Array.isArray(notificationIds)) {
        await prisma.notification.updateMany({ where: { id: { in: notificationIds }, userId: session.userId }, data: { read: true } });
      }
      return new NextResponse('Notifications updated', { status: 200 });
    }

    if (request.method === 'DELETE') {
      const id = request.nextUrl.searchParams.get('id');
      if (id) {
        await prisma.notification.deleteMany({ where: { id, userId: session.userId } });
      } else {
        await prisma.notification.deleteMany({ where: { userId: session.userId } });
      }
      return new NextResponse('Notifications deleted', { status: 200 });
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[NOTIFICATIONS]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

export async function notificationPrefsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    if (request.method === 'GET') {
      let prefs = await prisma.notificationPreference.findUnique({ where: { userId: session.userId } });
      if (!prefs) {
        prefs = await prisma.notificationPreference.create({ data: { userId: session.userId } });
      }
      return NextResponse.json(prefs);
    }

    if (request.method === 'PUT') {
      const body = await request.json();
      const allowed = ['emailDigest', 'digestTime', 'mention', 'comment', 'report', 'system', 'marketing', 'security', 'product'];
      const data: Record<string, any> = {};
      for (const key of allowed) {
        if (body[key] !== undefined) data[key] = body[key];
      }
      // Upsert
      await prisma.notificationPreference.upsert({
        where: { userId: session.userId },
        create: { userId: session.userId, ...data },
        update: data,
      });
      return new NextResponse('Notification preferences updated', { status: 200 });
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[NOTIFICATION_PREFS]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

export async function integrationsHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    if (request.method === 'GET') {
      const integrations = await prisma.integration.findMany({
        where: { userId: session.userId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, provider: true, connected: true, createdAt: true, updatedAt: true },
      });
      return NextResponse.json(integrations);
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const { provider, connected } = body;
      if (!provider) return new NextResponse('provider required', { status: 400 });
      const integration = await prisma.integration.upsert({
        where: { userId_provider: { userId: session.userId, provider } },
        update: { connected: connected ?? true },
        create: { userId: session.userId, provider, connected: connected ?? true },
      });
      return NextResponse.json(integration);
    }

    if (request.method === 'DELETE') {
      const body = await request.json();
      const { provider } = body;
      if (!provider) return new NextResponse('provider required', { status: 400 });
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
    if (!session) return new NextResponse('Unauthorized', { status: 401 });
    const limit = Number(request.nextUrl.searchParams.get('limit')) || 30;
    const logs = await prisma.auditEvent.findMany({
      where: { actorId: session.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, action: true, targetType: true, targetId: true, metadata: true, severity: true, createdAt: true },
    });
    return NextResponse.json(logs);
  } catch (err: any) {
    console.error('[USER ACTIVITY]', err?.message || err);
    return new NextResponse('Failed to fetch activity', { status: 500 });
  }
}

export async function preferencesHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    if (request.method === 'GET') {
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: {
          theme: true, language: true, timezone: true, dateFormat: true,
          timeFormat: true, fontSize: true, reduceMotion: true, highContrast: true, preferences: true,
        },
      });
      // Flatten extra fields from preferences JSON blob to top level
      const prefs = (user?.preferences as Record<string, any>) || {};
      return NextResponse.json({
        ...user,
        weekStart: prefs.weekStart || null,
        currency: prefs.currency || null,
        defaultLanding: prefs.defaultLanding || null,
      });
    }

    if (request.method === 'PATCH') {
      const body = await request.json();
      const bodyStr = JSON.stringify(body);
      if (bodyStr.length > 10240) return new NextResponse('Payload too large (max 10KB)', { status: 413 });
      const schema = z.object({
        theme: z.enum(['light', 'dark', 'system']).optional(),
        language: z.string().optional(),
        timezone: z.string().optional(),
        dateFormat: z.string().optional(),
        timeFormat: z.string().optional(),
        fontSize: z.string().optional(),
        reduceMotion: z.boolean().optional(),
        highContrast: z.boolean().optional(),
        preferences: z.any().optional(),
      });
      const parsed = schema.safeParse(body);
      if (!parsed.success) return new NextResponse('Invalid payload', { status: 400 });
      const data: Record<string, any> = { ...parsed.data };
      // Merge extra fields into preferences JSON blob
      const extraKeys = ['weekStart', 'currency', 'defaultLanding'];
      const existingPrefs = (await prisma.user.findUnique({ where: { id: session.userId }, select: { preferences: true } }))?.preferences as Record<string, any> || {};
      for (const key of extraKeys) {
        if (data[key] !== undefined) {
          data.preferences = { ...existingPrefs, ...data.preferences, [key]: data[key] };
          delete data[key];
        }
      }
      // Also merge preferences if present
      if (data.preferences && typeof data.preferences === 'object') {
        data.preferences = { ...existingPrefs, ...data.preferences };
      }
      await prisma.user.update({ where: { id: session.userId }, data });
      return new NextResponse('Preferences updated', { status: 200 });
    }

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
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    const body = await request.json();
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
      await prisma.user.update({
        where: { id: session.userId },
        data: { lastActiveAt: new Date() },
      });
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
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

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
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    const { code } = await request.json();
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
    if (!session) return new NextResponse('Unauthorized', { status: 401 });

    const formData = await request.formData();
    const file = formData.get('avatar') as File | null;
    if (!file) return new NextResponse('No file uploaded', { status: 400 });

    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.type)) return new NextResponse('Invalid file type. Allowed: JPEG, PNG, WebP, GIF', { status: 400 });
    if (file.size > 5 * 1024 * 1024) return new NextResponse('File too large. Max 5MB', { status: 400 });

    const ext = file.name.split('.').pop() || 'jpg';
    const fileName = `avatar-${session.userId}-${Date.now()}.${ext}`;

    const r2Endpoint = process.env.R2_ENDPOINT;
    const r2AccessKey = process.env.R2_ACCESS_KEY;
    const r2SecretKey = process.env.R2_SECRET_KEY;
    const r2Bucket = process.env.R2_BUCKET;
    const r2PublicUrl = process.env.R2_PUBLIC_URL;

    let photoUrl: string;

    if (r2Endpoint && r2AccessKey && r2SecretKey && r2Bucket && r2PublicUrl) {
      const arrayBuffer = await file.arrayBuffer();
      const { putObject } = await import('./storage');
      await putObject({
        endpoint: r2Endpoint,
        accessKey: r2AccessKey,
        secretKey: r2SecretKey,
        bucket: r2Bucket,
        key: `avatars/${fileName}`,
        body: Buffer.from(arrayBuffer),
        contentType: file.type,
      });
      photoUrl = `${r2PublicUrl}/avatars/${fileName}`;
    } else {
      return new NextResponse('File storage not configured. Contact admin.', { status: 503 });
    }

    await prisma.user.update({
      where: { id: session.userId },
      data: { photoUrl },
    });

    return NextResponse.json({ photoUrl, message: 'Avatar updated' });
  } catch (err: any) {
    console.error('[AVATAR UPLOAD]', err?.message || err);
    return new NextResponse('Failed to upload avatar', { status: 500 });
  }
}

export async function districtsHandler(request: NextRequest) {
  try {
    if (request.method === 'GET') {
      const districts = await prisma.district.findMany({ orderBy: { name: 'asc' } });
      return NextResponse.json(districts);
    }
    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[DISTRICTS]', err?.message || err);
    return new NextResponse('Failed to fetch districts', { status: 500 });
  }
}
