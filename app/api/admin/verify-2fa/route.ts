import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../lib/db/prisma';
import { createSession, setSessionCookie } from '@/lib/session';
import { verifyTemp2faToken } from '../../../../lib/auth/jwt';
import { verifyTotp } from '../../../../lib/auth/totp';
import { sendTemplateEmail } from '../../../../lib/email';

const verifySchema = z.object({
  tempToken: z.string().min(1),
  token: z.string().min(6).optional(),
  code: z.string().min(6).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = verifySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

    const { tempToken } = parsed.data;
    const totpCode = parsed.data.code || parsed.data.token || '';
    if (!totpCode) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

    const userId = await verifyTemp2faToken(tempToken);
    if (!userId) return NextResponse.json({ error: 'Invalid or expired temp token' }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, totpSecret: true, is2FAEnabled: true, adminRole: true },
    });
    if (!user || !user.totpSecret || !user.is2FAEnabled) {
      return NextResponse.json({ error: '2FA not enabled' }, { status: 400 });
    }

    if (!await verifyTotp(totpCode, user.totpSecret)) {
      return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 401 });
    }

    const adminRole = user.adminRole || null;
    if (!adminRole) {
      sendTemplateEmail(user.email, 'admin_alert', {
        subject: 'Unauthorized Admin Access Attempt',
        message: 'A user without admin privileges attempted to access the admin panel.',
        details: `<p>Email: ${user.email}</p><p>Time: ${new Date().toLocaleString()}</p>`,
        dashboardUrl: 'https://admin.tirbeo.app',
      }, { rawVars: ['details'] }).catch(() => {});
      return NextResponse.json({ error: 'Access denied. You do not have admin privileges.' }, { status: 403 });
    }

    const ip = request.headers.get('x-forwarded-for') || '';
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip, adminRole);
    const res = NextResponse.json({ id: user.id, email: user.email });
    setSessionCookie(res, token, refreshToken);
    return res;
  } catch (err: any) {
    console.error('[ADMIN LOGIN] 2FA error:', err?.message || err);
    return NextResponse.json({ error: '2FA verification failed' }, { status: 500 });
  }
}
