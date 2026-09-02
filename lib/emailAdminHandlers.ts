import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { requireAdmin } from './session';
import { sendEmail } from './email';
import { z } from 'zod';

// GET /api/email/config — get current email config
export async function emailConfigHandler(request: NextRequest) {
  try {
    const session = await requireAdmin(request);
    if (session instanceof NextResponse) return session;

    if (request.method === 'GET') {
      const config = await prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
      if (!config) return NextResponse.json({ provider: 'resend', enabled: false, fromEmail: 'noreply@send.tirbeo.app', fromName: 'Tirbeo' });
      const { apiKey, smtpPass, ...safeConfig } = config as any;
      return NextResponse.json({
        ...safeConfig,
        apiKey: apiKey ? '••••' + apiKey.slice(-4) : null,
        smtpPass: smtpPass ? '••••' : null,
      });
    }

    if (request.method === 'PATCH') {
      const body: any = await request.json();
      const schema = z.object({
        provider: z.enum(['resend', 'smtp']).optional(),
        resendApiKey: z.string().optional(),
        resendDomain: z.string().optional(),
        smtpHost: z.string().optional(),
        smtpPort: z.number().optional(),
        smtpUser: z.string().optional(),
        smtpPass: z.string().optional(),
        defaultFromEmail: z.string().email().optional(),
        defaultFromName: z.string().optional(),
        welcomeFromEmail: z.string().email().optional().nullable(),
        welcomeFromName: z.string().optional().nullable(),
        otpFromEmail: z.string().email().optional().nullable(),
        otpFromName: z.string().optional().nullable(),
        resetFromEmail: z.string().email().optional().nullable(),
        resetFromName: z.string().optional().nullable(),
        notifyFromEmail: z.string().email().optional().nullable(),
        notifyFromName: z.string().optional().nullable(),
        alertFromEmail: z.string().email().optional().nullable(),
        alertFromName: z.string().optional().nullable(),
        customDomain: z.string().optional().nullable(),
        dkimEnabled: z.boolean().optional(),
        enabled: z.boolean().optional(),
      });
      const parsed = schema.safeParse(body);
      if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

      const existing = await prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
      if (existing) {
        const updated = await prisma.emailConfig.update({ where: { id: existing.id }, data: parsed.data });
        return NextResponse.json(updated);
      }
      const created = await prisma.emailConfig.create({ data: parsed.data });
      return NextResponse.json(created, { status: 201 });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[EMAIL CONFIG]', err?.message || err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET /api/email/templates — list all templates
// POST /api/email/templates — create new template
export async function emailTemplatesHandler(request: NextRequest) {
  try {
    const session = await requireAdmin(request);
    if (session instanceof NextResponse) return session;

    if (request.method === 'GET') {
      const templates = await prisma.emailTemplate.findMany({ orderBy: { createdAt: 'asc' } });
      return NextResponse.json(templates);
    }

    if (request.method === 'POST') {
      const body: any = await request.json();
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
      if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

      const existing = await prisma.emailTemplate.findUnique({ where: { name: parsed.data.name } });
      if (existing) return NextResponse.json({ error: 'Template name already exists' }, { status: 409 });

      const template = await prisma.emailTemplate.create({ data: parsed.data as any });
      return NextResponse.json(template, { status: 201 });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[EMAIL TEMPLATES]', err?.message || err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET /api/email/templates/[name] — get single template
// PATCH /api/email/templates/[name] — update template
// DELETE /api/email/templates/[name] — delete template
export async function emailTemplateDetailHandler(request: NextRequest, name: string) {
  try {
    const session = await requireAdmin(request);
    if (session instanceof NextResponse) return session;

    const existing = await prisma.emailTemplate.findUnique({ where: { name } });
    if (!existing) return NextResponse.json({ error: 'Template not found' }, { status: 404 });

    if (request.method === 'GET') {
      return NextResponse.json(existing);
    }

    if (request.method === 'PATCH') {
      const body: any = await request.json();
      const schema = z.object({
        label: z.string().min(1).optional(),
        subject: z.string().min(1).optional(),
        htmlBody: z.string().min(1).optional(),
        variables: z.any().optional(),
        fromEmail: z.string().email().optional().nullable(),
        fromName: z.string().optional().nullable(),
      });
      const parsed = schema.safeParse(body);
      if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

      const updated = await prisma.emailTemplate.update({ where: { name }, data: parsed.data as any });
      return NextResponse.json(updated);
    }

    if (request.method === 'DELETE') {
      await prisma.emailTemplate.delete({ where: { name } });
      return NextResponse.json({ error: 'Deleted' }, { status: 200 });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[EMAIL TEMPLATE DETAIL]', err?.message || err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/email/test — send a test email
export async function emailTestHandler(request: NextRequest) {
  try {
    const session = await requireAdmin(request);
    if (session instanceof NextResponse) return session;

    const body: any = await request.json();
    const schema = z.object({
      to: z.string().email(),
      templateName: z.string().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

    const config = await prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    const diagnostics = {
      hasDbConfig: !!config,
      dbEnabled: config?.enabled ?? null,
      dbApiKey: config?.resendApiKey ? '••••' + config.resendApiKey.slice(-4) : null,
      dbProvider: config?.provider ?? null,
      envApiKey: process.env.RESEND_API_KEY ? '••••' + process.env.RESEND_API_KEY.slice(-4) : null,
    };

    const result = await (async () => {
      const { sendTemplateEmail } = await import('./email');
      return sendTemplateEmail(parsed.data.to, 'admin_test', { sentFor: 'the admin panel email settings' });
    })();
    return NextResponse.json({ ...result, diagnostics });
  } catch (err: any) {
    console.error('[EMAIL TEST]', err?.message || err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET /api/admin/emails — list sent emails
export async function adminEmailsHandler(request: NextRequest) {
  try {
    const session = await requireAdmin(request);
    if (session instanceof NextResponse) return session;

    if (request.method === 'GET') {
      const { searchParams } = new URL(request.url);
      const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
      const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50')));
      const skip = (page - 1) * limit;
      const status = searchParams.get('status');
      const template = searchParams.get('template');
      const to = searchParams.get('to');

      const where: Record<string, any> = {};
      if (status) where.status = status;
      if (template) where.template = template;
      if (to) where.toEmail = { contains: to };

      const [emails, total] = await Promise.all([
        prisma.email_logs.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            toEmail: true,
            fromEmail: true,
            subject: true,
            template: true,
            status: true,
            threadId: true,
            replyTo: true,
            openedAt: true,
            clickedAt: true,
            error: true,
            metadata: true,
            createdAt: true,
          },
        }),
        prisma.email_logs.count({ where }),
      ]);

      return NextResponse.json({ emails, total, page, limit });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[ADMIN EMAILS]', err?.message || err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/admin/emails/reply — send a reply to an existing thread
export async function adminEmailReplyHandler(request: NextRequest) {
  try {
    const session = await requireAdmin(request);
    if (session instanceof NextResponse) return session;

    if (request.method === 'POST') {
      const body: any = await request.json();
      const schema = z.object({
        to: z.string().email(),
        subject: z.string().min(1),
        html: z.string().min(1),
        threadId: z.string().optional(),
        replyTo: z.string().email().optional(),
      });
      const parsed = schema.safeParse(body);
      if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

      const { to, subject, html, threadId, replyTo } = parsed.data;
      const result = await sendEmail(to, subject, html, {
        replyTo: replyTo || 'alerts@send.tirbeo.app',
        threadId,
        templateName: 'admin_reply',
        fromEmail: 'alerts@send.tirbeo.app',
        fromName: 'Tirbeo Support',
      });

      if (result.success) {
        return NextResponse.json({ ...result, message: 'Reply sent successfully' });
      }
      return NextResponse.json({ error: result.error || 'Failed to send reply' }, { status: 500 });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[ADMIN EMAIL REPLY]', err?.message || err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET /api/admin/emails/[id] — get single email details
export async function adminEmailDetailHandler(request: NextRequest, id: string) {
  try {
    const session = await requireAdmin(request);
    if (session instanceof NextResponse) return session;

    const email = await prisma.email_logs.findUnique({ where: { id } });
    if (!email) return NextResponse.json({ error: 'Email not found' }, { status: 404 });

    return NextResponse.json(email);
  } catch (err: any) {
    console.error('[ADMIN EMAIL DETAIL]', err?.message || err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
