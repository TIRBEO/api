import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireRole } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await requireRole(request, 'manager');
    if (session instanceof NextResponse) return session;

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const skip = (page - 1) * limit;

    const where: any = {};
    const userId = searchParams.get('userId');
    const ipAddress = searchParams.get('ipAddress');
    const eventType = searchParams.get('eventType');
    const rayId = searchParams.get('rayId');
    
    if (userId) where.userId = userId;
    if (ipAddress) where.ipAddress = ipAddress;
    if (eventType) where.eventType = eventType;
    if (rayId) where.rayId = rayId;

    const [logs, total] = await Promise.all([
      prisma.captchaLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.captchaLog.count({ where }),
    ]);

    return NextResponse.json({ logs, total, page, limit });
  } catch (err: any) {
    console.error('[CAPTCHA ADMIN] Get logs error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 });
  }
}
