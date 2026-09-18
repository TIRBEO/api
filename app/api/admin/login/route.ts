import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { adminLoginHandler } from '@/features/auth/authHandlers';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  captchaRayId: z.string().optional(),
  fingerprint: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = loginSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 400 });
    }

    const { email, password, captchaRayId, fingerprint } = parsed.data;
    return adminLoginHandler(request, parsed.data);
  } catch (err: any) {
    console.error('[ADMIN LOGIN] Authentication error:', err?.message || err);
    return NextResponse.json({ error: 'Login failed' }, { status: 500 });
  }
}

const verifySchema = z.object({
  tempToken: z.string().min(1),
  token: z.string().min(6).optional(),
  code: z.string().min(6).optional(),
});

async function handleVerify(request: NextRequest) {
  try {
    const parsed = verifySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

    const { tempToken } = parsed.data;
    const totpCode = parsed.data.code || parsed.data.token || '';
    if (!totpCode) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

    const { verifyTemp2faToken } = await import('@/features/auth/jwt');
    const userId = await verifyTemp2faToken(tempToken);
    if (!userId) return NextResponse.json({ error: 'Invalid or expired temp token' }, { status: 401 });

    const { prisma } = await import('@/infrastructure/db/prisma');
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, totpSecret: true, is2FAEnabled: true, adminRole: true, mustChangePassword: true },
    });
    if (!user || !user.totpSecret || !user.is2FAEnabled) {
      return NextResponse.json({ error: '2FA not enabled' }, { status: 400 });
    }

    const { verifyTotp } = await import('@/features/auth/totp');
    if (!await verifyTotp(totpCode, user.totpSecret)) {
      return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 401 });
    }

    if (!user.adminRole) {
      const { sendTemplateEmail } = await import('@/features/email/email');
      sendTemplateEmail(user.email, 'admin_alert', {
        subject: 'Unauthorized Admin Access Attempt',
        message: 'A user without admin privileges attempted to access the admin panel.',
        details: `<p>Email: ${user.email}</p><p>Time: ${new Date().toLocaleString()}</p>`,
        dashboardUrl: (await import('@/config/app-urls')).getAdminBaseUrl(),
      }, { rawVars: ['details'] }).catch(() => {});
      return NextResponse.json({ error: 'Access denied. You do not have admin privileges.' }, { status: 403 });
    }

    // 2FA satisfied but the account was provisioned with a temporary password —
    // force a password change before issuing any admin session.
    if (user.mustChangePassword) {
      const { signTempPasswordChangeToken } = await import('@/features/auth/jwt');
      const pwToken = await signTempPasswordChangeToken(user.id);
      return NextResponse.json({ needsPasswordChange: true, tempToken: pwToken });
    }

    const ip = request.headers.get('x-forwarded-for') || '';
    const { createSession, setSessionCookie } = await import('@/features/auth/http-guards');
    const adminRole = user.adminRole;
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip, adminRole);
    const res = NextResponse.json({ id: user.id, email: user.email });
    setSessionCookie(res, token, refreshToken);

    const { sendTemplateEmail: sendLoginAlert } = await import('@/features/email/email');
    sendLoginAlert(user.email, 'login_alert', {
      name: user.email.split('@')[0],
      location: 'Admin Panel',
      device: request.headers.get('user-agent') || 'Unknown device',
      loginTime: new Date().toLocaleString(),
    }).catch(() => {});

    // In-app notification for admin 2FA login (skipEmail — login_alert already sent above)
    const { createNotification } = await import('@/features/notifications/notifications');
    createNotification({
      userId: user.id,
      type: 'login',
      title: 'Signed in to admin panel with 2FA',
      body: `Admin login from IP: ${ip || 'unknown'}`,
      link: '/account/security',
      skipEmail: true,
    }).catch(() => {});

    return res;
  } catch (err: any) {
    console.error('[ADMIN LOGIN] 2FA error:', err?.message || err);
    return NextResponse.json({ error: '2FA verification failed' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  return handleVerify(request);
}
