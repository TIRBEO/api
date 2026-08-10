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

    const [blocks, total] = await Promise.all([
      prisma.captchaBlock.findMany({
        where: { blockedAt: { lte: new Date() }, unblockedAt: null },
        orderBy: { blockedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.captchaBlock.count({ where: { blockedAt: { lte: new Date() }, unblockedAt: null } }),
    ]);

    return NextResponse.json({ blocks, total, page, limit });
  } catch (err: any) {
    console.error('[CAPTCHA ADMIN] Get blocks error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch blocks' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireRole(request, 'admin');
    if (session instanceof NextResponse) return session;

    const body: any = await request.json();
    const { rayId, action } = body;
    
    if (action === 'unblock') {
      const block = await prisma.captchaBlock.findUnique({ where: { rayId } });
      if (!block) {
        return NextResponse.json({ error: 'Block not found' }, { status: 404 });
      }

      await prisma.captchaBlock.update({
        where: { rayId },
        data: {
          unblockedAt: new Date(),
          unblockedBy: 'admin',
        },
      });

      await prisma.captchaLog.create({
        data: {
          userId: block.userId,
          sessionId: block.sessionId,
          ipAddress: block.ipAddress,
          eventType: 'unblocked',
          rayId,
        },
      });

      return NextResponse.json({ success: true });
    }
    
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: any) {
    console.error('[CAPTCHA ADMIN] Block action error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to process action' }, { status: 500 });
  }
}
