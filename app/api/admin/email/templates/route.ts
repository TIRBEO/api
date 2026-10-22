import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requirePermission } from '@/features/auth/http-guards';
import { invalidateEmailTemplate } from '@/features/email/emailCache';

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, 'email.read');
  if (session instanceof NextResponse) return session;

  const templates = await prisma.emailTemplate.findMany({ orderBy: { slug: 'asc' } });
  return NextResponse.json(templates);
}

export async function POST(request: NextRequest) {
  const session = await requirePermission(request, 'email.configure');
  if (session instanceof NextResponse) return session;

  const payload: any = await request.json();
  const { name, label, subject, htmlBody, variables } = payload;

  if (!name || !label || !subject || !htmlBody) {
    return NextResponse.json({ error: 'name, label, subject, htmlBody required' }, { status: 400 });
  }

  const tpl = await prisma.emailTemplate.create({
    data: { slug: name, label, subject, html: htmlBody, variables: variables || [] } });
  await invalidateEmailTemplate(tpl.slug);
  return NextResponse.json(tpl, { status: 201 });
}
