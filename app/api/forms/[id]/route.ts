import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getSessionFromRequest } from '@/lib/auth/session';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({
      where: { id, userId: session.userId },
      include: {
        fields: { orderBy: { order: 'asc' } },
        connections: { orderBy: { order: 'asc' } },
        _count: { select: { submissions: true } },
      },
    });

    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });
    return NextResponse.json({ form });
  } catch (error: any) {
    console.error('[FORMS] GET/:id error:', error?.message);
    return NextResponse.json({ error: 'Failed to load form' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    const body: any = await req.json();
    const data: any = {};
    const fields = ['name', 'description', 'status', 'websiteUrl', 'successMessage', 'successRedirect',
      'redirectTarget', 'notificationEmails', 'ccEmails', 'bccEmails', 'replyToEmail', 'emailSubject',
      'fromName', 'autoReply', 'autoReplySubject', 'autoReplyBody', 'spamProtection', 'turnstileKey',
      'rateLimit', 'allowedOrigins', 'honeypot', 'storeResponses', 'retention', 'showMetadata',
      'layout', 'width', 'alignment', 'labelPosition', 'theme', 'customCss', 'headless',
      'headerImage', 'accentColor', 'bgColor', 'headerFont', 'questionFont', 'headerImageHeight'];
    for (const f of fields) {
      if (body[f] !== undefined) data[f] = body[f];
    }

    const updated = await prisma.form.update({
      where: { id },
      data,
      include: { fields: { orderBy: { order: 'asc' } } },
    });

    return NextResponse.json({ form: updated });
  } catch (error: any) {
    console.error('[FORMS] PATCH/:id error:', error?.message);
    return NextResponse.json({ error: 'Failed to update form' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    await prisma.form.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[FORMS] DELETE/:id error:', error?.message);
    return NextResponse.json({ error: 'Failed to delete form' }, { status: 500 });
  }
}
