import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requireAdmin } from '@/features/auth/http-guards';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const templates = await prisma.emailTemplate.findMany({ orderBy: { name: 'asc' } });
  return NextResponse.json(templates);
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const payload: any = await request.json();
  const { name, label, subject, htmlBody, variables, fromEmail, fromName } = payload;

  if (!name || !label || !subject || !htmlBody) {
    return NextResponse.json({ error: 'name, label, subject, htmlBody required' }, { status: 400 });
  }

  const tpl = await prisma.emailTemplate.create({
    data: { name, label, subject, htmlBody, variables: variables || [], fromEmail, fromName },
  });
  return NextResponse.json(tpl, { status: 201 });
}
