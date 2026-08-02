import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { adminLoginHandler } from '@/lib/authHandlers';

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
      return new NextResponse('Invalid email or password', { status: 400 });
    }

    const { email, password, captchaRayId, fingerprint } = parsed.data;
    return adminLoginHandler(request);
  } catch (err: any) {
    console.error('[ADMIN LOGIN] Authentication error:', err?.message || err);
    return new NextResponse('Login failed', { status: 500 });
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
    if (!parsed.success) return new NextResponse('Invalid payload', { status: 400 });

    const { tempToken } = parsed.data;
    const totpCode = parsed.data.code || parsed.data.token || '';
    if (!totpCode) return new NextResponse('Invalid payload', { status: 400 });

    const { verifyTemp2faToken } = await import('../../../../lib/auth/jwt');
    const userId = await verifyTemp2faToken(tempToken);
    if (!userId) return new NextResponse('Invalid or expired temp token', { status: 401 });

    const { prisma } = await import('../../../../lib/db/prisma');
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, totpSecret: true, is2FAEnabled: true, adminRole: true, roles: { include: { role: true } } },
    });
    if (!user || !user.totpSecret || !user.is2FAEnabled) {
      return new NextResponse('2FA not enabled', { status: 400 });
    }

    const { verifyTotp } = await import('../../../../lib/auth/totp');
    if (!await verifyTotp(totpCode, user.totpSecret)) {
      return new NextResponse('Invalid 2FA code', { status: 401 });
    }

    if (!user.adminRole && !user.roles?.[0]?.role) {
      const { sendTemplateEmail } = await import('../../../../lib/email');
      sendTemplateEmail(user.email, 'admin_alert', {
        subject: 'Unauthorized Admin Access Attempt',
        message: 'A user without admin privileges attempted to access the admin panel.',
        details: `<p>Email: ${user.email}</p><p>Time: ${new Date().toLocaleString()}</p>`,
        dashboardUrl: 'https://admin.tirbeo.app',
      }).catch(() => {});
      return new NextResponse('Access denied. You do not have admin privileges.', { status: 403 });
    }

    const ip = request.headers.get('x-forwarded-for') || '';
    const { createSession, setSessionCookie } = await import('@/lib/session');
    const adminRole = user.adminRole || user.roles?.[0]?.role?.name;
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip, adminRole);
    const res = NextResponse.json({ id: user.id, email: user.email });
    setSessionCookie(res, token, refreshToken);

    const { sendTemplateEmail: sendLoginAlert } = await import('../../../../lib/email');
    sendLoginAlert(user.email, 'login_alert', {
      name: user.email.split('@')[0],
      location: 'Admin Panel',
      device: request.headers.get('user-agent') || 'Unknown device',
      loginTime: new Date().toLocaleString(),
    }).catch(() => {});

    return res;
  } catch (err: any) {
    console.error('[ADMIN LOGIN] 2FA error:', err?.message || err);
    return new NextResponse('2FA verification failed', { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  return handleVerify(request);
}
