import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requirePermission } from '@/features/auth/http-guards';
import { invalidateEmailTemplate } from '@/features/email/emailCache';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission(request, 'email.read');
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const tpl = await prisma.emailTemplate.findUnique({ where: { id } });
  if (!tpl) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(tpl);
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission(request, 'email.configure');
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const body: any = await request.json();
  const tpl = await prisma.emailTemplate.update({
    where: { id },
    data: {
      ...(body.label !== undefined && { label: body.label }),
      ...(body.subject !== undefined && { subject: body.subject }),
      ...(body.htmlBody !== undefined && { html: body.htmlBody }),
      ...(body.variables !== undefined && { variables: body.variables }),
    },
  });
  await invalidateEmailTemplate(tpl.slug);
  return NextResponse.json(tpl);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const sess = await requirePermission(request, 'email.configure');
  if (sess instanceof NextResponse) return sess;

  const { id } = await params;
  // `delete` returns the row it removed, which is the slug the send path
  // caches under — dropping it here is why an edited template shows up on the
  // next mail rather than up to five minutes later.
  const gone = await prisma.emailTemplate.delete({ where: { id } });
  await invalidateEmailTemplate(gone.slug);
  return NextResponse.json({ ok: true });
}
