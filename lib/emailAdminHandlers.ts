import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { sendEmail } from './email';
import { z } from 'zod';

async function requireAdmin(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { adminRole: true } });
  if (!user?.adminRole) return null;
  return session.userId;
}

// GET /api/email/config — get current email config
export async function emailConfigHandler(request: NextRequest) {
  const adminId = await requireAdmin(request);
  if (!adminId) return new NextResponse('Unauthorized', { status: 401 });

  if (request.method === 'GET') {
    const config = await prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (!config) return NextResponse.json({ provider: 'resend', enabled: false, fromEmail: 'noreply@tirbeo.app', fromName: 'Tirbeo' });
    const { apiKey, smtpPass, ...safeConfig } = config as any;
    return NextResponse.json({
      ...safeConfig,
      apiKey: apiKey ? '••••' + apiKey.slice(-4) : null,
      smtpPass: smtpPass ? '••••' : null,
    });
  }

  if (request.method === 'PATCH') {
    const body = await request.json();
    const schema = z.object({
      provider: z.enum(['resend', 'smtp']).optional(),
      apiKey: z.string().optional(),
      smtpHost: z.string().optional(),
      smtpPort: z.number().optional(),
      smtpUser: z.string().optional(),
      smtpPass: z.string().optional(),
      fromEmail: z.string().email().optional(),
      fromName: z.string().optional(),
      enabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return new NextResponse('Invalid payload', { status: 400 });

    const existing = await prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (existing) {
      const updated = await prisma.emailConfig.update({ where: { id: existing.id }, data: parsed.data });
      return NextResponse.json(updated);
    }
    const created = await prisma.emailConfig.create({ data: parsed.data as any });
    return NextResponse.json(created, { status: 201 });
  }

  return new NextResponse('Method not allowed', { status: 405 });
}

// GET /api/email/templates — list all templates
// POST /api/email/templates — create new template
export async function emailTemplatesHandler(request: NextRequest) {
  const adminId = await requireAdmin(request);
  if (!adminId) return new NextResponse('Unauthorized', { status: 401 });

  if (request.method === 'GET') {
    const templates = await prisma.emailTemplate.findMany({ orderBy: { createdAt: 'asc' } });
    return NextResponse.json(templates);
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const schema = z.object({
      name: z.string().min(1),
      label: z.string().min(1),
      subject: z.string().min(1),
      htmlBody: z.string().min(1),
      variables: z.any().optional(),
      fromEmail: z.string().email().optional(),
      fromName: z.string().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return new NextResponse('Invalid payload', { status: 400 });

    const existing = await prisma.emailTemplate.findUnique({ where: { name: parsed.data.name } });
    if (existing) return new NextResponse('Template name already exists', { status: 409 });

    const template = await prisma.emailTemplate.create({ data: parsed.data as any });
    return NextResponse.json(template, { status: 201 });
  }

  return new NextResponse('Method not allowed', { status: 405 });
}

// GET /api/email/templates/[name] — get single template
// PATCH /api/email/templates/[name] — update template
// DELETE /api/email/templates/[name] — delete template
export async function emailTemplateDetailHandler(request: NextRequest, name: string) {
  const adminId = await requireAdmin(request);
  if (!adminId) return new NextResponse('Unauthorized', { status: 401 });

  const existing = await prisma.emailTemplate.findUnique({ where: { name } });
  if (!existing) return new NextResponse('Template not found', { status: 404 });

  if (request.method === 'GET') {
    return NextResponse.json(existing);
  }

  if (request.method === 'PATCH') {
    const body = await request.json();
    const schema = z.object({
      label: z.string().min(1).optional(),
      subject: z.string().min(1).optional(),
      htmlBody: z.string().min(1).optional(),
      variables: z.any().optional(),
      fromEmail: z.string().email().optional().nullable(),
      fromName: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return new NextResponse('Invalid payload', { status: 400 });

    const updated = await prisma.emailTemplate.update({ where: { name }, data: parsed.data as any });
    return NextResponse.json(updated);
  }

  if (request.method === 'DELETE') {
    await prisma.emailTemplate.delete({ where: { name } });
    return new NextResponse('Deleted', { status: 200 });
  }

  return new NextResponse('Method not allowed', { status: 405 });
}

// POST /api/email/test — send a test email
export async function emailTestHandler(request: NextRequest) {
  const adminId = await requireAdmin(request);
  if (!adminId) return new NextResponse('Unauthorized', { status: 401 });

  const body = await request.json();
  const schema = z.object({
    to: z.string().email(),
    templateName: z.string().optional(),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return new NextResponse('Invalid payload', { status: 400 });

  const result = await sendEmail(parsed.data.to, 'Tirbeo Test Email', '<p style="font-family:system-ui;padding:24px">This is a test email from Tirbeo. If you received this, your email configuration is working.</p>');
  return NextResponse.json(result);
}
