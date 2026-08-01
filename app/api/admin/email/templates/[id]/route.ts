import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../../../lib/db/prisma';
import { requireAdmin } from '../../../../../../lib/session';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const tpl = await prisma.emailTemplate.findUnique({ where: { id } });
  if (!tpl) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(tpl);
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const body = await request.json();
  const tpl = await prisma.emailTemplate.update({
    where: { id },
    data: {
      ...(body.label !== undefined && { label: body.label }),
      ...(body.subject !== undefined && { subject: body.subject }),
      ...(body.htmlBody !== undefined && { htmlBody: body.htmlBody }),
      ...(body.variables !== undefined && { variables: body.variables }),
      ...(body.fromEmail !== undefined && { fromEmail: body.fromEmail }),
      ...(body.fromName !== undefined && { fromName: body.fromName }),
    },
  });
  return NextResponse.json(tpl);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const sess = await requireAdmin(request);
  if (sess instanceof NextResponse) return sess;

  const { id } = await params;
  await prisma.emailTemplate.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
