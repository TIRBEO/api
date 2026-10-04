import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requireAdmin } from '@/features/auth/http-guards';
import { sendEmail } from '@/features/email/email';
import { z } from 'zod';

// The email_settings table is gone — admin config now lives in the
// app_config row keyed 'email.config' (JSON), same source email.ts reads.
const EMAIL_CONFIG_KEY = 'email.config';

async function readEmailConfig(): Promise<Record<string, any>> {
  const row = await prisma.appConfig.findUnique({ where: { key: EMAIL_CONFIG_KEY } }).catch(() => null);
  return row && typeof row.value === 'object' && row.value !== null ? row.value as Record<string, any> : {};
}

// GET /api/email/config — get current email config
export async function emailConfigHandler(request: NextRequest) {
  try {
    const session = await requireAdmin(request);
    if (session instanceof NextResponse) return session;

    if (request.method === 'GET') {
      const config = await readEmailConfig();
      if (!Object.keys(config).length) return NextResponse.json({ provider: 'resend', enabled: false, fromEmail: 'noreply@send.tirbeo.com', fromName: 'Tirbeo' });
      const { apiKey, smtpPass, resendApiKey, ...safeConfig } = config;
      return NextResponse.json({
        ...safeConfig,
        apiKey: apiKey ? '••••' + String(apiKey).slice(-4) : null,
        resendApiKey: resendApiKey ? '••••' + String(resendApiKey).slice(-4) : null,
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

      const merged = { ...(await readEmailConfig()), ...parsed.data };
      const row = await prisma.appConfig.upsert({
        where: { key: EMAIL_CONFIG_KEY },
        update: { value: merged },
        create: { key: EMAIL_CONFIG_KEY, value: merged, description: 'Email provider + sender configuration' },
      });
      return NextResponse.json(row.value, { status: 200 });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[EMAIL CONFIG]', err?.message || err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// The admin UI was built against { name, htmlBody } — keep that shape on the
// wire while the table uses slug/html.
function templateForUi(t: any) {
  if (!t) return t;
  return { ...t, name: t.slug, htmlBody: t.html };
}

// GET /api/email/templates — list all templates
// POST /api/email/templates — create new template
export async function emailTemplatesHandler(request: NextRequest) {
  try {
    const session = await requireAdmin(request);
    if (session instanceof NextResponse) return session;

    if (request.method === 'GET') {
      const templates = await prisma.emailTemplate.findMany({ orderBy: { createdAt: 'asc' } });
      return NextResponse.json(templates.map(templateForUi));
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

      const slug = parsed.data.name.trim().toLowerCase();
      const existing = await prisma.emailTemplate.findUnique({ where: { slug } });
      if (existing) return NextResponse.json({ error: 'Template name already exists' }, { status: 409 });

      const template = await prisma.emailTemplate.create({
        data: {
          slug,
          label: parsed.data.label,
          subject: parsed.data.subject,
          html: parsed.data.htmlBody,
          variables: (parsed.data.variables ?? []) as any,
        },
      });
      return NextResponse.json(templateForUi(template), { status: 201 });
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

    const slug = name.trim().toLowerCase();
    const existing = await prisma.emailTemplate.findUnique({ where: { slug } });
    if (!existing) return NextResponse.json({ error: 'Template not found' }, { status: 404 });

    if (request.method === 'GET') {
      return NextResponse.json(templateForUi(existing));
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

      const updated = await prisma.emailTemplate.update({
        where: { slug },
        data: {
          ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
          ...(parsed.data.subject !== undefined ? { subject: parsed.data.subject } : {}),
          ...(parsed.data.htmlBody !== undefined ? { html: parsed.data.htmlBody } : {}),
          ...(parsed.data.variables !== undefined ? { variables: parsed.data.variables as any } : {}),
        },
      });
      return NextResponse.json(templateForUi(updated));
    }

    if (request.method === 'DELETE') {
      await prisma.emailTemplate.delete({ where: { slug } });
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

    const config = await readEmailConfig();
    const hasDbConfig = !!Object.keys(config).length;
    const diagnostics = {
      hasDbConfig,
      dbEnabled: config?.enabled ?? null,
      dbApiKey: config?.resendApiKey ? '••••' + String(config.resendApiKey).slice(-4) : null,
      dbProvider: config?.provider ?? null,
      envApiKey: process.env.RESEND_API_KEY ? '••••' + process.env.RESEND_API_KEY.slice(-4) : null,
    };

    const result = await (async () => {
      const { sendTemplateEmail } = await import('@/features/email/email');
      return sendTemplateEmail(parsed.data.to, 'admin_test', { sentFor: 'the admin panel email settings' });
    })();
    return NextResponse.json({ ...result, diagnostics });
  } catch (err: any) {
    console.error('[EMAIL TEST]', err?.message || err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET /api/admin/emails — list sent emails (email_jobs + delivery events)
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
      if (template) where.templateSlug = { contains: template };
      if (to) where.toAddress = { contains: to };

      const [jobs, total] = await Promise.all([
        prisma.email_jobs.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.email_jobs.count({ where }),
      ]);

      // Attach opened/delivery events for the visible page in one query.
      const deliveries = jobs.length
        ? await prisma.email_deliveries.findMany({
            where: { jobId: { in: jobs.map((j) => j.id) } },
            orderBy: { createdAt: 'asc' },
          }).catch(() => [])
        : [];
      const openedByJob = new Set(deliveries.filter((d) => d.event === 'opened').map((d) => d.jobId));

      const emails = jobs.map((j) => {
        const payload: any = (j.payload && typeof j.payload === 'object' ? j.payload : {}) as any;
        return {
          id: j.id,
          toEmail: j.toAddress,
          fromEmail: payload.fromEmail ?? null,
          subject: j.subject,
          eventKey: j.templateSlug,
          status: j.status,
          category: j.kind,
          provider: payload.provider ?? null,
          messageId: payload.messageId ?? null,
          openedAt: openedByJob.has(j.id) ? j.sentAt : null,
          clickedAt: null,
          error: j.lastError,
          metadata: payload.metadata ?? null,
          createdAt: j.createdAt,
        };
      });

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
        replyTo: replyTo || 'alerts@send.tirbeo.com',
        threadId,
        templateName: 'admin_reply',
        fromEmail: 'alerts@send.tirbeo.com',
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

    const job = await prisma.email_jobs.findUnique({ where: { id } }).catch(() => null);
    if (!job) return NextResponse.json({ error: 'Email not found' }, { status: 404 });
    const deliveries = await prisma.email_deliveries.findMany({
      where: { jobId: id },
      orderBy: { createdAt: 'asc' },
    }).catch(() => []);
    return NextResponse.json({ ...job, deliveries });
  } catch (err: any) {
    console.error('[ADMIN EMAIL DETAIL]', err?.message || err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
