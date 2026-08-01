import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireRole } from '@/lib/session';
import { getCaptchaSettings, updateCaptchaSettings } from '@/lib/captcha/service';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const settings = await getCaptchaSettings();
    return NextResponse.json(settings);
  } catch (err: any) {
    console.error('[CAPTCHA ADMIN] Get settings error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const body = await request.json();
    const settings = await updateCaptchaSettings(body);
    
    await prisma.captchaLog.create({
      data: {
        userId: (session as any).userId,
        sessionId: 'admin',
        ipAddress: (request.headers.get('x-forwarded-for') || '').split(',')[0].trim(),
        eventType: 'settings_changed',
        metadata: { changes: body },
      },
    });

    return NextResponse.json(settings);
  } catch (err: any) {
    console.error('[CAPTCHA ADMIN] Update settings error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
