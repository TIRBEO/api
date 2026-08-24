import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getSessionFromRequest } from '@/lib/auth/session';

// GET /api/forms/:id/connections — List connections for a form
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    const connections = await prisma.formConnection.findMany({
      where: { formId: id },
      orderBy: { order: 'asc' },
    });

    return NextResponse.json({ connections });
  } catch (error: any) {
    console.error('[FORMS] GET connections error:', error?.message);
    return NextResponse.json({ error: 'Failed to load connections' }, { status: 500 });
  }
}

// POST /api/forms/:id/connections — Create a new connection
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    const body: any = await req.json();
    const { type, name, config } = body;

    if (!type || !name) {
      return NextResponse.json({ error: 'type and name required' }, { status: 400 });
    }

    const allowedTypes = ['webhook', 'email', 'slack', 'discord', 'zapier'];
    if (!allowedTypes.includes(type)) {
      return NextResponse.json({ error: `Invalid type. Allowed: ${allowedTypes.join(', ')}` }, { status: 400 });
    }

    const maxOrder = await prisma.formConnection.aggregate({
      where: { formId: id },
      _max: { order: true },
    });

    const connection = await prisma.formConnection.create({
      data: {
        formId: id,
        type,
        name,
        config: config || {},
        isActive: true,
        order: (maxOrder._max.order || 0) + 1,
      },
    });

    return NextResponse.json({ connection }, { status: 201 });
  } catch (error: any) {
    console.error('[FORMS] POST connections error:', error?.message);
    return NextResponse.json({ error: 'Failed to create connection' }, { status: 500 });
  }
}

// PUT /api/forms/:id/connections — Bulk update connections
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    const body: any = await req.json();
    const { connections } = body;

    if (!Array.isArray(connections)) {
      return NextResponse.json({ error: 'connections array required' }, { status: 400 });
    }

    // Replace all connections
    await prisma.formConnection.deleteMany({ where: { formId: id } });
    for (let i = 0; i < connections.length; i++) {
      const c = connections[i];
      await prisma.formConnection.create({
        data: {
          formId: id,
          type: c.type || 'webhook',
          name: c.name || `Connection ${i + 1}`,
          config: c.config || {},
          isActive: c.isActive !== false,
          order: i,
        },
      });
    }

    const updated = await prisma.formConnection.findMany({
      where: { formId: id },
      orderBy: { order: 'asc' },
    });

    return NextResponse.json({ connections: updated });
  } catch (error: any) {
    console.error('[FORMS] PUT connections error:', error?.message);
    return NextResponse.json({ error: 'Failed to update connections' }, { status: 500 });
  }
}
