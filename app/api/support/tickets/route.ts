import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request);
    const body: any = await request.json();
    const { subject, title, message, description, category, priority, rayId, email, imageUrls } = body;

    const images = Array.isArray(imageUrls)
      ? imageUrls.filter((u: unknown): u is string => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u)).slice(0, 6)
      : [];

    if (!(subject || title) || (!(message || description) && images.length === 0)) {
      return NextResponse.json({ error: 'Subject and message are required' }, { status: 400 });
    }

    const baseDescription = message || description ? sanitizeInput(message || description, 20000) : '';
    const fullDescription = [baseDescription, ...images.map((u: string) => `![tirbeo-img](${u})`)]
      .filter(Boolean)
      .join('\n')
      .slice(0, 20000);

    const ticket = await prisma.ticket.create({
      data: {
        customerId: session?.userId,
        subject: sanitizeInput(subject || title, 300),
        description: fullDescription || undefined,
        category: category || 'general',
        priority: priority || 'normal',
        status: 'open',
        source: 'web',
      },
    });

    return NextResponse.json({ ...ticket, title: ticket.subject });
  } catch (err: any) {
    console.error('[SUPPORT] Create ticket error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to create ticket' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session?.userId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');
    const skip = (page - 1) * limit;

    const where: any = { customerId: session.userId };
    const status = searchParams.get('status');
    if (status) where.status = status;

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          customer: { select: { id: true, name: true, email: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      prisma.ticket.count({ where }),
    ]);

    const mapped = tickets.map(t => ({ ...t, title: t.subject }));
    return NextResponse.json({ tickets: mapped, total, page, limit });
  } catch (err: any) {
    console.error('[SUPPORT] Get tickets error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch tickets' }, { status: 500 });
  }
}

function sanitizeInput(value: string, max: number): string {
  return String(value || '').slice(0, max);
}
