import { prisma } from './db/prisma';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from './session';
import { sendTemplateEmail, sendEmail, escapeHtml } from './email';
import { sanitizeInput } from './security';
import { getCaptchaSettings, assertCaptchaSatisfied } from './captcha/service';

// Scalar columns on the `form` model; every other key a client sends is form
// configuration stored inside the `settings` JSON column (theme, banner, color…).
const FORM_COLUMN_KEYS = new Set([
  'title', 'description', 'status', 'thankYouMessage', 'allowCollaboratorEdits', 'captchaEnabled', 'settings',
]);

/** Split a client payload into scalar columns + settings-JSON entries. */
function splitFormPayload(payload: Record<string, any>): { columns: Record<string, any>; settings: Record<string, any> } {
  const columns: Record<string, any> = {};
  const settings: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (FORM_COLUMN_KEYS.has(key)) columns[key] = value;
    else settings[key] = value;
  }
  return { columns, settings };
}

/** Merge form.settings at the top level so `form.theme`, `form.bannerImage`, … work. */
function withSettings<T extends { settings?: unknown }>(form: T): T & Record<string, any> {
  const merged = { ...form } as any;
  if (form.settings && typeof form.settings === 'object') {
    for (const [key, value] of Object.entries(form.settings as Record<string, any>)) {
      if (merged[key] === undefined) merged[key] = value;
    }
  }
  return merged;
}

const createFormSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  thankYouMessage: z.string().optional(),
  allowCollaboratorEdits: z.boolean().optional(),
});

const updateFormSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  status: z.enum(['draft', 'published', 'archived', 'closed']).optional(),
  visibility: z.enum(['public', 'unlisted', 'private']).optional(),
  loginRequired: z.boolean().optional(),
  captchaEnabled: z.boolean().optional(),
  rateLimit: z.number().int().optional(),
  limitPerUser: z.number().int().optional(),
  responseLimit: z.number().int().optional(),
  expiresAt: z.string().datetime().optional(),
  scheduledAt: z.string().datetime().optional(),
  closeAt: z.string().datetime().optional(),
  openMessage: z.string().optional(),
  thankYouMessage: z.string().optional(),
  allowCollaboratorEdits: z.boolean().optional(),
  closeMessage: z.string().optional(),
  redirectUrl: z.string().optional(),
  collectEmail: z.boolean().optional(),
  confirmBeforeSubmit: z.boolean().optional(),
  showProgressBar: z.boolean().optional(),
  shuffleFields: z.boolean().optional(),
  allowEdit: z.boolean().optional(),
  allowDelete: z.boolean().optional(),
  color: z.string().optional(),
  fontSize: z.string().optional(),
  layout: z.string().optional(),
  coverImage: z.string().optional(),
  slug: z.string().optional(),
  customDomain: z.string().optional(),
  seoTitle: z.string().optional(),
  seoDescription: z.string().optional(),
  fields: z.array(z.object({
    id: z.string(),
    type: z.string(),
    label: z.string(),
    required: z.boolean().optional(),
    order: z.number().int(),
    placeholder: z.string().optional(),
    description: z.string().optional(),
    options: z.array(z.object({
      label: z.string(),
      value: z.string(),
    })).optional(),
  })).optional(),
});

function generatePublicId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

async function getUserId(req: NextRequest): Promise<string | null> {
  const session = await getSession(req);
  return session?.userId || null;
}

export async function listForms(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const search = searchParams.get('search');
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');
  const skip = (page - 1) * limit;

  const where: any = {
    OR: [
      { ownerId: userId },
      { collaborators: { some: { userId } } },
    ],
  };
  if (status) where.status = status;
  if (search) where.title = { contains: search, mode: 'insensitive' };

  const [forms, total] = await Promise.all([
    prisma.form.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit,
      include: { _count: { select: { fields: true } } },
    }),
    prisma.form.count({ where }),
  ]);

  return NextResponse.json({ forms, total, page, limit });
}

export async function createForm(req: NextRequest) {
   const userId = await getUserId(req);
   if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

   const flag = await prisma.featureFlag.findUnique({ where: { key: 'forms.userCreation.enabled' } });
   if (!flag?.isActive) {
     return NextResponse.json({ error: { code: 'FEATURE_DISABLED', message: 'User-created forms are not available yet. We\'re preparing this feature for 2027.' } }, { status: 403 });
   }

   const body = await req.json();
  const parsed = createFormSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid form data', fields: parsed.error.flatten().fieldErrors } }, { status: 400 });
  }

const form = await prisma.form.create({
     data: {
       title: parsed.data.title,
       description: parsed.data.description,
       ownerId: userId,
       publicId: generatePublicId(),
       status: 'draft',
       thankYouMessage: parsed.data.thankYouMessage,
       allowCollaboratorEdits: parsed.data.allowCollaboratorEdits ?? false,
     },
   });

  return NextResponse.json(form, { status: 201 });
}

export async function getForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const form = await prisma.form.findFirst({
    where: {
      id: formId,
      OR: [
        { ownerId: userId },
        { collaborators: { some: { userId } } },
      ],
    },
    include: {
      fields: { orderBy: { order: 'asc' }, include: { options: { orderBy: { order: 'asc' } } } },
      pages: { orderBy: { order: 'asc' } },
      collaborators: { include: { user: { select: { id: true, name: true, email: true, photoUrl: true } } } },
      versions: { orderBy: { version: 'desc' }, take: 1 },
    },
  });

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });
  return NextResponse.json(withSettings(form));
}

export async function updateForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const form = await prisma.form.findFirst({
    where: {
      id: formId,
      OR: [
        { ownerId: userId },
        { collaborators: { some: { userId, role: { in: ['editor', 'admin'] } } } },
      ],
    },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const body = await req.json();
  const parsed = updateFormSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid form data', fields: parsed.error.flatten().fieldErrors } }, { status: 400 });
  }

  const { fields, ...formData } = parsed.data;

  if (fields) {
    await prisma.formField.deleteMany({ where: { formId } });
    await prisma.formFieldOption.deleteMany({ where: { field: { formId } } });
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const { options, ...fieldData } = f;
      const created = await prisma.formField.create({
        data: {
          formId,
          type: fieldData.type,
          label: fieldData.label,
          required: fieldData.required || false,
          order: fieldData.order,
          placeholder: fieldData.placeholder,
        },
      });
      if (options && options.length > 0) {
        await prisma.formFieldOption.createMany({
          data: options.map((o, oi) => ({
            fieldId: created.id,
            label: o.label,
            value: o.value,
            order: oi,
          })),
        });
      }
    }
  }

  const { columns, settings: settingsPatch } = splitFormPayload(formData);
  const current = await prisma.form.findUnique({ where: { id: formId }, select: { settings: true } });
  const mergedSettings = { ...((current?.settings as object) || {}), ...settingsPatch };
  const updated = await prisma.form.update({
    where: { id: formId },
    data: {
      ...columns,
      ...(Object.keys(settingsPatch).length > 0 ? { settings: mergedSettings } : {}),
    },
  });

  await prisma.formVersion.create({
    data: {
      formId,
      version: (form.versions?.[0]?.version || 0) + 1,
      data: updated,
      createdBy: userId,
    },
  });

  return NextResponse.json(updated);
}

export async function deleteForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const form = await prisma.form.findFirst({
    where: { id: formId, ownerId: userId },
  });

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  await prisma.form.delete({ where: { id: formId } });

  const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
  if (owner?.email) {
    await sendFormLifecycleEmail(owner.email, form, {
      badge: 'Form deleted',
      title: 'Your form was deleted',
      subtitle: 'A form was permanently removed from your account',
      body: `This action cannot be undone. If this was a mistake, you can create a new form or contact support for help.`,
      details: [{ label: 'Deleted', value: new Date().toLocaleString() }],
      cta: { url: `${process.env.FORMS_URL || 'https://forms.tirbeo.app'}/new`, label: 'Create a new form' },
      subject: `Your form "${form.title || 'Untitled Form'}" has been deleted`,
    }, 'form_deleted');
  }

  return NextResponse.json({ success: true }, { status: 200 });
}

export async function publishForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const form = await prisma.form.findFirst({
    where: {
      id: formId,
      OR: [
        { ownerId: userId },
        { collaborators: { some: { userId, role: { in: ['editor', 'admin'] } } } },
      ],
    },
  });

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const updated = await prisma.form.update({
    where: { id: formId },
    data: { status: 'published', publishedAt: new Date() },
  });

  const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
  if (owner?.email) {
    await sendFormLifecycleEmail(owner.email, form, {
      badge: 'Published',
      title: 'Your form is now live',
      subtitle: 'Your form is now accepting responses',
      body: `Anyone with the link can now view and fill out your form. Share it to start collecting responses right away.`,
      details: [{ label: 'Published', value: new Date().toLocaleString() }],
      cta: { url: `${process.env.FORMS_URL || 'https://forms.tirbeo.app'}/f/${form.publicId}`, label: 'View form' },
      subject: `Your form "${form.title || 'Untitled Form'}" is now live`,
    }, 'form_published');
  }

  return NextResponse.json(updated);
}

export async function archiveForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const form = await prisma.form.findFirst({
    where: { id: formId, ownerId: userId },
  });

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const updated = await prisma.form.update({
    where: { id: formId },
    data: { status: 'archived' },
  });

  const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
  if (owner?.email) {
    await sendFormLifecycleEmail(owner.email, form, {
      badge: 'Archived',
      title: 'Your form has been archived',
      subtitle: 'Your form is no longer visible to respondents',
      body: `Archived forms are hidden from your dashboard but can be restored anytime. No new responses will be collected while it is archived.`,
      details: [{ label: 'Archived', value: new Date().toLocaleString() }],
      cta: { url: `${process.env.FORMS_URL || 'https://forms.tirbeo.app'}/builder/${form.id}`, label: 'Open in editor' },
      subject: `Your form "${form.title || 'Untitled Form'}" has been archived`,
    }, 'form_archived');
  }

  return NextResponse.json(updated);
}

export async function getPublicForm(req: NextRequest, publicId: string) {
  const form = await prisma.form.findUnique({
    where: { publicId },
    include: {
      fields: { orderBy: { order: 'asc' }, include: { options: { orderBy: { order: 'asc' } } } },
      pages: { orderBy: { order: 'asc' }, include: { fields: { orderBy: { order: 'asc' } } } },
    },
  });

  if (!form || form.status !== 'published') {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });
  }

  await prisma.form.update({
    where: { id: form.id },
    data: { viewCount: { increment: 1 } },
  });

  return NextResponse.json(withSettings(form));
}

// ─── Themed respondent confirmation email (form's own theme colors) ──────

/** Rough luminance of a hex color (0 = black, 255 = white). Handles 3/6-digit hex. */
function hexLuminance(hex: string): number {
  let h = hex.replace('#', '').trim();
  if (!/^[0-9a-f]{3}$/i.test(h) && !/^[0-9a-f]{6}$/i.test(h)) return 128;
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function formEmailTheme(form: any) {
  const s = (form?.settings && typeof form.settings === 'object' ? form.settings : {}) as Record<string, any>;
  const t = (s.theme && typeof s.theme === 'object' ? s.theme : {}) as Record<string, any>;
  const primary = t.primaryColor || s.color || '#17150f';
  const accent = t.accentColor || primary;
  // A dark theme uses light text, so high text luminance ⇒ dark theme.
  const isDark = hexLuminance(t.textColor || (s.textColor || '')) > 200;
  let background = t.backgroundColor || (isDark ? '#111827' : '#f6f3ea');
  const surface = t.surfaceColor || (isDark ? '#1f2937' : '#ffffff');
  const text = t.textColor || (isDark ? '#f6f3ea' : '#17150f');
  const textMuted = t.textMutedColor || (isDark ? '#9ca3af' : '#6b7280');
  const border = t.borderColor || (isDark ? '#3f3f46' : '#17150f');
  if (typeof background === 'string' && background.startsWith('linear-gradient')) {
    background = isDark ? '#111827' : '#f6f3ea';
  }
  return { primary, accent, background, surface, text, textMuted, border, isDark };
}

function buildFormConfirmationEmail(form: any, responseId: string, body: any): { subject: string; html: string } {
  const c = formEmailTheme(form);
  const formTitle = escapeHtml(form.title || 'Untitled Form');
  const name = escapeHtml(body.respondentName?.trim() || 'there');
  const thankYou = escapeHtml(form.thankYouMessage || 'Thank you for your response!');
  const submittedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const rows = Object.entries(body.answers || {})
    .map(([fieldId, value]) => {
      const field = form.fields?.find((f: any) => f.id === fieldId);
      const label = escapeHtml(field?.label || fieldId);
      const display = Array.isArray(value) ? value.join(', ') : String(value ?? '');
      const val = escapeHtml(display);
      return `<tr><td style="padding:12px 0;border-bottom:1px solid ${c.border};vertical-align:top;"><div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${c.accent};margin-bottom:3px;">${label}</div><div style="font-size:15px;line-height:22px;color:${c.text};">${val || '<em style="color:' + c.textMuted + '">—</em>'}</div></td></tr>`;
    })
    .join('');

  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your response was recorded</title></head>` +
    `<body style="margin:0;padding:0;background:${c.background};font-family:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:${c.text};-webkit-font-smoothing:antialiased;">` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="background:${c.background};padding:48px 16px;"><tr><td align="center">` +
    `<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${c.surface};border:2px solid ${c.border};border-radius:12px;overflow:hidden;">` +
    // Header band
    `<tr><td style="padding:36px 40px 8px;text-align:center;"><span style="display:inline-block;width:52px;height:52px;border-radius:50%;background:${c.accent};color:#ffffff;font-size:26px;line-height:52px;text-align:center;font-weight:800;">✓</span>` +
    `<h1 style="margin:18px 0 6px;font-size:24px;font-weight:800;color:${c.text};">Your response was recorded</h1>` +
    `<p style="margin:0;font-size:14px;line-height:22px;color:${c.textMuted};">Thank you for submitting <strong style="color:${c.text};">${formTitle}</strong>.</p></td></tr>` +
    // Body
    `<tr><td style="padding:24px 40px 32px;">` +
    `<p style="margin:0 0 18px;font-size:16px;line-height:26px;color:${c.text};">Hi ${name},</p>` +
    `<p style="margin:0 0 24px;font-size:16px;line-height:26px;color:${c.textMuted};">${thankYou}</p>` +
    (rows ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;"><tr><td style="font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:${c.accent};padding-bottom:6px;">Your answers</td></tr></table><table width="100%" cellpadding="0" cellspacing="0">${rows}</table>` : '') +
    `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;"><tr><td style="padding:14px 16px;border:2px solid ${c.border};border-radius:8px;"><p style="margin:0;font-size:12px;line-height:20px;color:${c.textMuted};"><strong style="color:${c.text};">Submitted:</strong> ${submittedAt} &middot; <strong style="color:${c.text};">ID:</strong> ${responseId.slice(0, 8)}</p></td></tr></table>` +
    `<p style="margin:22px 0 0;font-size:12px;line-height:20px;color:${c.textMuted};">If you didn't submit this form, you can safely ignore this email.</p>` +
    `</td></tr>` +
    // Footer
    `<tr><td style="padding:20px 40px;border-top:2px solid ${c.border};text-align:center;background:${c.surface};"><p style="margin:0;font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${c.accent};">Tirbeo Forms</p><p style="margin:8px 0 0;font-size:11px;line-height:18px;color:${c.textMuted};">Powered by Tirbeo &middot; <a href="https://tirbeo.app/privacy" style="color:${c.accent};">Privacy</a> &middot; <a href="https://tirbeo.app/terms" style="color:${c.accent};">Terms</a></p></td></tr>` +
    `</table></td></tr></table></body></html>`;

  return { subject: `Your response to ${form.title || 'this form'} was recorded`, html };
}

function buildFormOwnerEmail(form: any, response: any, body: any): { subject: string; html: string } {
  const c = formEmailTheme(form);
  const formTitle = escapeHtml(form.title || 'Untitled Form');
  const respondentName = escapeHtml(body.respondentName?.trim() || 'Anonymous');
  const respondentEmail = escapeHtml(body.respondentEmail || 'N/A');
  const submittedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const rows = Object.entries(body.answers || {})
    .map(([fieldId, value]) => {
      const field = form.fields?.find((f: any) => f.id === fieldId);
      const label = escapeHtml(field?.label || fieldId);
      const display = Array.isArray(value) ? value.join(', ') : String(value ?? '');
      const val = escapeHtml(display);
      return `<tr><td style="padding:12px 0;border-bottom:1px solid ${c.border};vertical-align:top;"><div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${c.accent};margin-bottom:3px;">${label}</div><div style="font-size:15px;line-height:22px;color:${c.text};">${val || '<em style="color:' + c.textMuted + '">—</em>'}</div></td></tr>`;
    })
    .join('');

  const adminUrl = `${process.env.ADMIN_URL || 'https://admin.tirbeo.app'}/forms/${form.id}/responses`;

  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>New form response</title></head>` +
    `<body style="margin:0;padding:0;background:${c.background};font-family:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:${c.text};-webkit-font-smoothing:antialiased;">` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="background:${c.background};padding:48px 16px;"><tr><td align="center">` +
    `<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${c.surface};border:2px solid ${c.border};border-radius:12px;overflow:hidden;">` +
    `<tr><td style="padding:36px 40px 8px;text-align:center;"><span style="display:inline-block;padding:8px 14px;border-radius:999px;background:${c.accent};color:#ffffff;font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;">New response</span>` +
    `<h1 style="margin:16px 0 6px;font-size:24px;font-weight:800;color:${c.text};">${formTitle}</h1>` +
    `<p style="margin:0;font-size:14px;line-height:22px;color:${c.textMuted};">A new response was submitted.</p></td></tr>` +
    `<tr><td style="padding:24px 40px 32px;">` +
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:14px 16px;border:2px solid ${c.border};border-radius:8px;"><p style="margin:0;font-size:13px;line-height:22px;color:${c.textMuted};"><strong style="color:${c.text};">Respondent:</strong> ${respondentName} (${respondentEmail})</p><p style="margin:6px 0 0;font-size:13px;line-height:22px;color:${c.textMuted};"><strong style="color:${c.text};">Submitted:</strong> ${submittedAt} &middot; <strong style="color:${c.text};">ID:</strong> ${response.id.slice(0, 8)}</p></td></tr></table>` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;"><tr><td style="font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:${c.accent};padding-bottom:6px;">Answers</td></tr></table><table width="100%" cellpadding="0" cellspacing="0">${rows}</table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;"><tr><td align="center"><a href="${adminUrl}" style="display:inline-block;padding:15px 32px;background:${c.accent};color:#ffffff;font-size:13px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;text-decoration:none;border-radius:8px;">View responses</a></td></tr></table>` +
    `</td></tr>` +
    `<tr><td style="padding:20px 40px;border-top:2px solid ${c.border};text-align:center;"><p style="margin:0;font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${c.accent};">Tirbeo Forms</p><p style="margin:8px 0 0;font-size:11px;line-height:18px;color:${c.textMuted};">You are receiving this because you own this form.</p></td></tr>` +
    `</table></td></tr></table></body></html>`;

  return { subject: `New response to "${form.title || 'Untitled Form'}"`, html };
}

/** Generic themed lifecycle email shell (published/archived/deleted/response events). */
export function buildThemedFormLifecycleEmail(form: any, opts: {
  badge: string;
  title: string;
  subtitle: string;
  intro?: string;
  body: string;
  details?: { label: string; value: string }[];
  cta?: { url: string; label: string };
  /** Secondary call-to-action (e.g. the appeal link in flagged emails). */
  cta2?: { url: string; label: string };
  footer?: string;
  subject: string;
}): { subject: string; html: string } {
  const c = formEmailTheme(form);
  const formTitle = escapeHtml(form.title || 'Untitled Form');

  const detailsRows = (opts.details || [])
    .map((d) => `<p style="margin:6px 0 0;font-size:13px;line-height:22px;color:${c.textMuted};"><strong style="color:${c.text};">${escapeHtml(d.label)}:</strong> ${escapeHtml(d.value)}</p>`)
    .join('');

  const ctaHtml = opts.cta
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;"><tr><td align="center"><a href="${opts.cta.url}" style="display:inline-block;padding:15px 32px;background:${c.accent};color:#ffffff;font-size:13px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;text-decoration:none;border-radius:8px;">${escapeHtml(opts.cta.label)}</a></td></tr></table>`
    : '';

  // Secondary CTA (outline style) — used for the appeal link in flagged emails.
  const cta2Html = opts.cta2
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td align="center"><a href="${opts.cta2.url}" style="display:inline-block;padding:13px 28px;border:2px solid ${c.border};background:transparent;color:${c.text};font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;border-radius:8px;">${escapeHtml(opts.cta2.label)}</a></td></tr></table>`
    : '';

  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(opts.title)}</title></head>` +
    `<body style="margin:0;padding:0;background:${c.background};font-family:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:${c.text};-webkit-font-smoothing:antialiased;">` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="background:${c.background};padding:48px 16px;"><tr><td align="center">` +
    `<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${c.surface};border:2px solid ${c.border};border-radius:12px;overflow:hidden;">` +
    `<tr><td style="padding:36px 40px 8px;text-align:center;"><span style="display:inline-block;padding:8px 14px;border-radius:999px;background:${c.accent};color:#ffffff;font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;">${escapeHtml(opts.badge)}</span>` +
    `<h1 style="margin:16px 0 6px;font-size:24px;font-weight:800;color:${c.text};">${escapeHtml(opts.title)}</h1>` +
    `<p style="margin:0;font-size:14px;line-height:22px;color:${c.textMuted};">${escapeHtml(opts.subtitle)} <strong style="color:${c.text};">${formTitle}</strong>.</p></td></tr>` +
    `<tr><td style="padding:24px 40px 32px;">` +
    (opts.intro ? `<p style="margin:0 0 16px;font-size:16px;line-height:26px;color:${c.text};">${escapeHtml(opts.intro)}</p>` : '') +
    `<p style="margin:0;font-size:16px;line-height:26px;color:${c.textMuted};">${escapeHtml(opts.body)}</p>` +
    (detailsRows ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;"><tr><td style="padding:14px 16px;border:2px solid ${c.border};border-radius:8px;">${detailsRows}</td></tr></table>` : '') +
    ctaHtml +
    cta2Html +
    `<p style="margin:${opts.cta || opts.cta2 ? '22px' : '20px'} 0 0;font-size:12px;line-height:20px;color:${c.textMuted};">${escapeHtml(opts.footer || `If you did not expect this email about "${form.title || 'this form'}", you can safely ignore it.`)}</p>` +
    `</td></tr>` +
    `<tr><td style="padding:20px 40px;border-top:2px solid ${c.border};text-align:center;"><p style="margin:0;font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${c.accent};">Tirbeo Forms</p><p style="margin:8px 0 0;font-size:11px;line-height:18px;color:${c.textMuted};">You are receiving this because you own this form.</p></td></tr>` +
    `</table></td></tr></table></body></html>`;

  return { subject: opts.subject, html };
}

// Throttle owner flag emails so repeated failed captcha attempts can't spam the inbox.
const flagNotifyTimes = new Map<string, number>();
const FLAG_NOTIFY_INTERVAL_MS = 10 * 60 * 1000;

/** Fire-and-forget themed 'form flagged' email to the form owner when CAPTCHA blocks a submission. */
async function notifyFormFlagged(form: any, info: { rayId: string; reason: string; ip: string }) {
  try {
    const last = flagNotifyTimes.get(form.id) || 0;
    if (Date.now() - last < FLAG_NOTIFY_INTERVAL_MS) return;
    flagNotifyTimes.set(form.id, Date.now());
    const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
    if (!owner?.email) return;
    const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
    const supportBase = process.env.SUPPORT_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:3003' : `https://support.${appDomain}`);
    const appealParams = new URLSearchParams({
      appeal: '1',
      form: form.publicId || form.id,
      formTitle: form.title || 'Untitled Form',
      rayId: info.rayId,
      reason: info.reason,
    });
    const appealUrl = `${supportBase}/tickets/create?${appealParams.toString()}`;
    await sendFormLifecycleEmail(owner.email, form, {
      badge: 'Flagged',
      title: 'A submission was flagged',
      subtitle: 'CAPTCHA blocked a suspicious submission attempt',
      body: `A submission attempt to your form was blocked by CAPTCHA because it looked automated or suspicious. If you believe this is a mistake, you can appeal the block and our security team will review it.`,
      details: [
        { label: 'Ray ID', value: info.rayId },
        { label: 'Reason', value: info.reason },
        { label: 'IP address', value: info.ip },
        { label: 'Flagged', value: new Date().toLocaleString() },
      ],
      cta: { url: appealUrl, label: 'Appeal this block' },
      cta2: { url: `${process.env.ADMIN_URL || 'https://admin.tirbeo.app'}/security/captcha/blocks`, label: 'Review in admin' },
      footer: `Prefer email? Reply to this message and our team will review your appeal — include your Ray ID ${info.rayId}.`,
      subject: `A submission to "${form.title || 'Untitled Form'}" was flagged`,
    }, 'form_flagged', { replyTo: process.env.SUPPORT_EMAIL || 'appeals@tirbeo.app' });
  } catch (e: any) {
    console.error('[EMAIL] Failed to send form-flagged email:', e?.message);
  }
}

/** Fire-and-forget themed lifecycle email to the form owner (never blocks the request). */
export async function sendFormLifecycleEmail(ownerEmail: string, form: any, opts: Parameters<typeof buildThemedFormLifecycleEmail>[1], templateName = 'form_lifecycle', extra?: { replyTo?: string }) {
  try {
    const themed = buildThemedFormLifecycleEmail(form, opts);
    await sendEmail(ownerEmail, themed.subject, themed.html, {
      fromEmail: 'forms@send.tirbeo.app',
      fromName: 'Tirbeo Forms',
      templateName,
      ...(extra?.replyTo ? { replyTo: extra.replyTo } : {}),
    });
  } catch (e: any) {
    console.error('[EMAIL] Failed to send form lifecycle email:', e?.message);
  }
}

export async function submitResponse(req: NextRequest, publicId: string) {
  const form = await prisma.form.findUnique({
    where: { publicId },
    include: { fields: true },
  });

  if (!form || form.status !== 'published') {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';
  const session = await getSession(req);
  const userId = session?.userId || null;

  const body = await req.json();

  if (form.captchaEnabled) {
    const settings = await getCaptchaSettings();
    if (settings.enabled) {
      const captchaRayId = body.captchaRayId;
      if (!captchaRayId) {
        return NextResponse.json({ error: { code: 'CAPTCHA_REQUIRED', message: 'CAPTCHA verification is required' } }, { status: 403 });
      }
      const check = await assertCaptchaSatisfied({
        rayId: captchaRayId,
        sessionId: session?.sessionId || req.cookies.get('__captcha_session')?.value || 'anonymous',
        ipAddress: ip,
        userAgent,
        fingerprint: req.headers.get('x-device-fingerprint') || '',
        requiredDifficulty: 'medium',
      });
      if (!check.ok) {
        // A failed human check on a captcha-protected form — flag the owner with a themed email.
        await notifyFormFlagged(form, { rayId: captchaRayId, reason: check.error, ip });
        return NextResponse.json({ error: { code: 'CAPTCHA_FAILED', message: check.error || 'CAPTCHA verification failed' } }, { status: 403 });
      }
    }
  }

  const cleanAnswers = Object.entries(body.answers || {}).map(([fieldId, value]) => ({
    fieldId,
    value: typeof value === 'string' ? sanitizeInput(value, 20000) : value,
  }));

  const response = await prisma.response.create({
    data: {
      formId: form.id,
      respondentEmail: body.respondentEmail ? sanitizeInput(String(body.respondentEmail), 254) : undefined,
      respondentName: body.respondentName ? sanitizeInput(String(body.respondentName), 200) : undefined,
      ipAddress: ip,
      userAgent: userAgent,
      status: 'completed',
      completedAt: new Date(),
      answers: { create: cleanAnswers as any },
    },
  });

  await prisma.form.update({
    where: { id: form.id },
    data: {
      responseCount: { increment: 1 },
      lastSubmissionAt: new Date(),
      submissionCountToday: { increment: 1 },
    },
  });

  try {
    const owner = await prisma.user.findUnique({ where: { id: form.ownerId } });
    if (owner?.email) {
      const themed = buildFormOwnerEmail(form, response, body);
      await sendEmail(owner.email, themed.subject, themed.html, {
        fromEmail: 'forms@send.tirbeo.app',
        fromName: 'Tirbeo Forms',
        templateName: 'form_response',
      });
    }
  } catch (e: any) {
    console.error('[EMAIL] Failed to send form response notification:', e?.message);
  }

  if (body.respondentEmail) {
    try {
      const themed = buildFormConfirmationEmail(form, response.id, body);
      await sendEmail(body.respondentEmail, themed.subject, themed.html, {
        fromEmail: 'forms@send.tirbeo.app',
        fromName: 'Tirbeo Forms',
        templateName: 'form_submission_confirmation',
      });
    } catch (e: any) {
      console.error('[EMAIL] Failed to send submission confirmation:', e?.message);
    }
  }

  return NextResponse.json({ id: response.id, message: form.thankYouMessage || 'Thank you!' }, { status: 201 });
}

export async function listResponses(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '50');
  const skip = (page - 1) * limit;
  const sortBy = searchParams.get('sortBy') || 'createdAt';
  const sortOrder = searchParams.get('sortOrder') || 'desc';

  const [responses, total] = await Promise.all([
    prisma.response.findMany({
      where: { formId },
      orderBy: { [sortBy]: sortOrder },
      skip,
      take: limit,
      include: { answers: { include: { field: true } } },
    }),
    prisma.response.count({ where: { formId } }),
  ]);

  return NextResponse.json({ responses, total, page, limit });
}

export async function getResponse(req: NextRequest, formId: string, responseId: string) {
   const userId = await getUserId(req);
   if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

   const form = await prisma.form.findUnique({ where: { id: formId } });
   if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

   const isOwner = form.ownerId === userId;
   const isCollaborator = !isOwner && await prisma.formCollaborator.findFirst({
     where: { formId, userId, role: { in: ['editor', 'admin'] } },
   });

   if (!isOwner && !isCollaborator) {
     return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
   }

   const response = await prisma.response.findFirst({
     where: { id: responseId, formId },
     include: {
       answers: { include: { field: { include: { options: true } } } },
       notes: { orderBy: { createdAt: 'desc' } },
     },
   });

   if (!response) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Response not found' } }, { status: 404 });
   return NextResponse.json(response);
 }

export async function deleteResponse(req: NextRequest, formId: string, responseId: string) {
   const userId = await getUserId(req);
   if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

   const form = await prisma.form.findUnique({ where: { id: formId } });
   if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

   const isOwner = form.ownerId === userId;
   const isCollaborator = !isOwner && await prisma.formCollaborator.findFirst({
     where: { formId, userId, role: { in: ['editor', 'admin'] } },
   });

   if (!isOwner && !isCollaborator) {
     return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
   }

   const response = await prisma.response.findFirst({
     where: { id: responseId, formId },
   });

   if (!response) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Response not found' } }, { status: 404 });

   await prisma.response.delete({ where: { id: responseId } });

   await prisma.form.update({
     where: { id: formId },
     data: { responseCount: { decrement: 1 } },
   });

   const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
   if (owner?.email) {
     await sendFormLifecycleEmail(owner.email, form, {
       badge: 'Response deleted',
       title: 'A response was deleted',
       subtitle: 'A response to your form was removed',
       body: `The response was permanently removed from your form's response list.`,
       details: [
         { label: 'Response ID', value: responseId.slice(0, 8) },
         { label: 'Deleted', value: new Date().toLocaleString() },
       ],
       cta: { url: `${process.env.ADMIN_URL || 'https://admin.tirbeo.app'}/forms/${form.id}/responses`, label: 'View responses' },
       subject: `A response to "${form.title || 'Untitled Form'}" was deleted`,
     }, 'response_deleted');
   }

 return NextResponse.json({ success: true });
  }

  export async function updateResponse(req: NextRequest, formId: string, responseId: string) {
    const userId = await getUserId(req);
    if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

    const form = await prisma.form.findUnique({ where: { id: formId } });
    if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

    const isOwner = form.ownerId === userId;
    const isCollaborator = !isOwner && await prisma.formCollaborator.findFirst({
      where: { formId, userId, role: { in: ['editor', 'admin'] } },
    });

    if (!isOwner && !isCollaborator) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
    }

    const response = await prisma.response.findFirst({
      where: { id: responseId, formId },
    });

    if (!response) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Response not found' } }, { status: 404 });

    // Only allow editing if the respondent is the owner or the form allows collaborator edits
    const canEdit = isOwner || form.allowCollaboratorEdits;
    if (!canEdit && response.respondentEmail) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Respondents can only edit their own responses if the form owner allows it' } }, { status: 403 });
    }

    const body = await req.json();
    const { answers, status, notes } = body;

    const updated = await prisma.response.update({
      where: { id: responseId },
      data: {
        ...(answers && { answers: { deleteMany: {}, create: Object.entries(answers).map(([fieldId, value]) => ({ fieldId, value: value as any })) } }),
        ...(status && { status }),
        ...(notes && { notes: { create: notes.map((n: any) => ({ userId: n.userId, content: n.content })) } }),
      },
      include: { answers: { include: { field: true } } },
    });

    const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
    if (owner?.email) {
      await sendFormLifecycleEmail(owner.email, form, {
        badge: 'Response updated',
        title: 'A response was updated',
        subtitle: 'A response to your form was modified',
        body: `The response content was edited by an authorized user. Review the changes if needed.`,
        details: [
          { label: 'Response ID', value: responseId.slice(0, 8) },
          { label: 'Updated', value: new Date().toLocaleString() },
        ],
        cta: { url: `${process.env.ADMIN_URL || 'https://admin.tirbeo.app'}/forms/${form.id}/responses`, label: 'View responses' },
        subject: `A response to "${form.title || 'Untitled Form'}" was updated`,
      }, 'response_updated');
    }

    return NextResponse.json(updated);
  }

  export async function getFormAnalytics(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const [form, responses, totalResponses] = await Promise.all([
    prisma.form.findUnique({ where: { id: formId }, include: { fields: true } }),
    prisma.response.findMany({
      where: { formId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, duration: true, status: true },
    }),
    prisma.response.count({ where: { formId } }),
  ]);

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const submissionsByDay = responses.reduce((acc: Record<string, number>, r) => {
    const day = r.createdAt.toISOString().slice(0, 10);
    acc[day] = (acc[day] || 0) + 1;
    return acc;
  }, {});

  const avgDuration = responses.reduce((sum, r) => sum + (r.duration || 0), 0) / (responses.length || 1);

  const completionRate = form.viewCount > 0 ? Math.round((totalResponses / form.viewCount) * 100) : 0;

  const fieldBreakdown = form.fields.map(field => {
    const fieldResponses = responses.filter(() => true).length;
    return {
      fieldId: field.id,
      fieldLabel: field.label,
      fieldType: field.type,
      responses: fieldResponses,
      skipped: 0,
    };
  });

  return NextResponse.json({
    totalResponses,
    totalViews: form.viewCount,
    completionRate,
    avgDuration: Math.round(avgDuration),
    submissionsByDay,
    lastSubmissionAt: form.lastSubmissionAt,
    fieldCount: form.fields.length,
    fieldBreakdown,
  });
}

export async function listCollaborators(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const collaborators = await prisma.formCollaborator.findMany({
    where: { formId },
    include: { user: { select: { id: true, name: true, email: true, photoUrl: true } } },
  });

  const form = await prisma.form.findUnique({
    where: { id: formId },
    select: { ownerId: true },
  });

  return NextResponse.json({ collaborators, ownerId: form?.ownerId });
}

export async function addCollaborator(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const body = await req.json();
  const { email, role = 'editor' } = body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, { status: 404 });

  const existing = await prisma.formCollaborator.findUnique({
    where: { formId_userId: { formId, userId: user.id } },
  });

  if (existing) return NextResponse.json({ error: { code: 'CONFLICT', message: 'User is already a collaborator' } }, { status: 409 });

  const collaborator = await prisma.formCollaborator.create({
    data: { formId, userId: user.id, role },
    include: { user: { select: { id: true, name: true, email: true, photoUrl: true } } },
  });

  return NextResponse.json(collaborator, { status: 201 });
}

export async function removeCollaborator(req: NextRequest, formId: string, collaboratorId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  await prisma.formCollaborator.delete({
    where: { id: collaboratorId, formId },
  });

  return NextResponse.json({ success: true });
}

export async function listVersions(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const versions = await prisma.formVersion.findMany({
    where: { formId },
    orderBy: { version: 'desc' },
    take: 50,
  });

  return NextResponse.json({ versions });
}

export async function restoreVersion(req: NextRequest, formId: string, versionId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const version = await prisma.formVersion.findFirst({
    where: { id: versionId, formId },
  });

  if (!version) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Version not found' } }, { status: 404 });

  const data = version.data as any;
  await prisma.form.update({
    where: { id: formId },
    data: {
      title: data.title,
      description: data.description,
    },
  });

  return NextResponse.json({ success: true, message: `Restored to version ${version.version}` });
}

export async function getFormSettings(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const [form, notifications] = await Promise.all([
    prisma.form.findUnique({ where: { id: formId } }),
    prisma.formNotification.findUnique({ where: { formId } }),
  ]);

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  return NextResponse.json({ form: withSettings(form), notifications });
}

export async function updateFormSettings(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const body = await req.json();
  const { notifications, ...rest } = body;

  const { columns, settings: settingsPatch } = splitFormPayload(rest);
  if (Object.keys(columns).length > 0) {
    await prisma.form.update({ where: { id: formId }, data: columns });
  }
  if (Object.keys(settingsPatch).length > 0) {
    const current = await prisma.form.findUnique({ where: { id: formId }, select: { settings: true } });
    const mergedSettings = { ...((current?.settings as object) || {}), ...settingsPatch };
    await prisma.form.update({ where: { id: formId }, data: { settings: mergedSettings } });
  }

  if (notifications) {
    await prisma.formNotification.upsert({
      where: { formId },
      update: notifications,
      create: { formId, ...notifications },
    });
  }

  return NextResponse.json({ success: true });
}

export async function publicDirectory(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const search = searchParams.get('search');
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');

  const where: any = { status: 'published' };
  if (search) where.title = { contains: search, mode: 'insensitive' };

  const [forms, total] = await Promise.all([
    prisma.form.findMany({
      where,
      orderBy: { responseCount: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        title: true,
        description: true,
        publicId: true,
        responseCount: true,
        createdAt: true,
        _count: { select: { fields: true } },
      },
    }),
    prisma.form.count({ where }),
  ]);

  return NextResponse.json({ forms, total, page, limit });
}

export async function exportResponses(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const format = new URL(req.url).searchParams.get('format') || 'csv';

  const [form, responses] = await Promise.all([
    prisma.form.findUnique({ where: { id: formId }, include: { fields: { orderBy: { order: 'asc' } } } }),
    prisma.response.findMany({
      where: { formId },
      orderBy: { createdAt: 'desc' },
      include: { answers: { include: { field: true } } },
    }),
  ]);

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  if (format === 'csv') {
    const headers = ['Submitted At', 'Respondent', ...form.fields.map(f => f.label)];
    const rows = responses.map(r => {
      const answerMap: Record<string, string> = {};
      r.answers.forEach(a => { answerMap[a.fieldId] = JSON.stringify(a.value); });
      return [
        r.createdAt.toISOString(),
        r.respondentEmail || '',
        ...form.fields.map(f => answerMap[f.id] || ''),
      ];
    });

    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${(v || '').replace(/"/g, '""')}"`).join(','))].join('\n');

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${form.title.replace(/[^a-zA-Z0-9]/g, '_')}.csv"`,
      },
    });
  }

  return NextResponse.json({ responses, fields: form.fields });
}
