import { prisma, withRetry } from './db/prisma';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from './session';
import { jsonUnauthorized } from './response';
import { sendTemplateEmail, sendEmail, escapeHtml } from './email';
import { sanitizeInput, sanitizeCss, sanitizeHtml, detectXss } from './security';
import { createHash, createHmac, randomBytes } from 'crypto';
import { getCaptchaSettings, assertCaptchaSatisfied } from './captcha/service';
import { createAuditEvent } from './audit';
import { createTtlCache } from './cache';
import {
  checkSubmissionRateLimit,
  checkSubmissionBurst,
  sanitizeSubmissionAnswers,
  validateSubmission,
} from './formSecurity';
import {
  isValidFieldType,
  normalizeFieldConfig,
  normalizeLogicRules,
  type FormDefinition,
  type FormField as RegistryFormField,
} from '@tirbeo/types';

// Cache for feature flag lookups — these are rarely changed and hit DB on every form create/import
const featureFlagCache = createTtlCache<boolean | null>(30_000, 500, 'featureFlags');

// ─── Owner notification tracking (bursts + dormant-form revival) ─────────
const formRecentSubmissions = new Map<string, { times: number[]; boomNotifiedAt: number }>();
const BOOM_WINDOW_MS = 10 * 60 * 1000; // watch the last 10 minutes
const BOOM_THRESHOLD = 5;              // ≥ 5 submissions in the window ⇒ spike
const BOOM_COOLDOWN_MS = 30 * 60 * 1000; // at most one spike email per 30 min
const DORMANT_DAYS = 7;                // no submission for 7+ days ⇒ revival email

// ─── Form webhook delivery ─────────────────────────────────────────────
const WEBHOOK_TIMEOUT_MS = 10_000;

function webhookSignature(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function buildWebhookPayload(opts: {
  form: { id: string; publicId: string | null; title: string };
  responseId: string;
  submittedAt: string;
  fields: any[];
  answers: Record<string, any>;
  respondentName?: string | null;
  respondentEmail?: string | null;
  ip?: string | null;
}) {
  const byId = new Map<string, any>((opts.fields || []).map((f: any) => [f.id, f]));
  const fields = Object.entries(opts.answers || {}).map(([fieldId, value]) => {
    const f = byId.get(fieldId);
    return { id: fieldId, type: f?.type || 'unknown', label: f?.label || fieldId, value };
  });
  return {
    event: 'form.submitted',
    formId: opts.form.id,
    formPublicId: opts.form.publicId || null,
    formTitle: opts.form.title,
    responseId: opts.responseId,
    submittedAt: opts.submittedAt,
    respondent: { name: opts.respondentName || null, email: opts.respondentEmail || null },
    ip: opts.ip || null,
    fields,
  };
}

async function deliverWebhook(settings: Record<string, any>, payload: object): Promise<{ ok: boolean; status: number }> {
  const url = settings.webhookUrl;
  if (typeof url !== 'string' || !url) return { ok: false, status: 0 };
  const secret = typeof settings.webhookSecret === 'string' ? settings.webhookSecret : '';
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Tirbeo-Webhook/1.0',
        'X-Form-Webhook-Event': 'form.submitted',
        'X-Form-Signature': webhookSignature(secret, body),
      },
      body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function sendFormWebhook(
  form: { id: string; publicId: string | null; title: string; settings: unknown },
  responseId: string,
  fields: any[],
  cleanAnswers: Record<string, any>,
  respondent: { name?: string | null; email?: string | null },
  ip?: string | null,
) {
  const settings = (form.settings && typeof form.settings === 'object' ? form.settings : {}) as Record<string, any>;
  const channels = (settings.notificationChannels && typeof settings.notificationChannels === 'object' ? settings.notificationChannels : {}) as Record<string, any>;
  if (typeof settings.webhookUrl !== 'string' || !settings.webhookUrl || channels.webhook === false) return;
  const payload = buildWebhookPayload({
    form,
    responseId,
    submittedAt: new Date().toISOString(),
    fields,
    answers: cleanAnswers,
    respondentName: respondent.name,
    respondentEmail: respondent.email,
    ip,
  });
  const first = await deliverWebhook(settings, payload);
  if (!first.ok) {
    await new Promise((r) => setTimeout(r, 1500));
    await deliverWebhook(settings, payload);
  }
}

export function sanitizeWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

export async function testFormWebhook(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);
  if (!(await canAccessForm(userId, formId))) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
  }
  const form = await prisma.form.findUnique({ where: { id: formId }, select: { id: true, publicId: true, title: true, settings: true } });
  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });
  const settings = (form.settings && typeof form.settings === 'object' ? form.settings : {}) as Record<string, any>;
  const url = sanitizeWebhookUrl(settings.webhookUrl);
  if (!url) return NextResponse.json({ error: { code: 'VALIDATION', message: 'Configure a webhook URL first' } }, { status: 400 });
  settings.webhookUrl = url;
  const payload = buildWebhookPayload({
    form,
    responseId: 'test',
    submittedAt: new Date().toISOString(),
    fields: [
      { id: 'name', type: 'text', label: 'Name' },
      { id: 'email', type: 'email', label: 'Email' },
    ],
    answers: { name: 'Test User', email: 'test@example.com' },
    respondentName: 'Test User',
    respondentEmail: 'test@example.com',
  });
  const result = await deliverWebhook(settings, payload);
  return NextResponse.json({ success: result.ok, status: result.status });
}

/** Track recent submissions for a form and decide whether to fire a "spike" email. */
function trackFormSpike(formId: string): { count: number; shouldNotify: boolean } {
  const now = Date.now();
  const entry = formRecentSubmissions.get(formId) || { times: [], boomNotifiedAt: 0 };
  entry.times = entry.times.filter((t) => now - t < BOOM_WINDOW_MS);
  entry.times.push(now);
  formRecentSubmissions.set(formId, entry);
  const shouldNotify = entry.times.length >= BOOM_THRESHOLD && now - entry.boomNotifiedAt > BOOM_COOLDOWN_MS;
  if (shouldNotify) entry.boomNotifiedAt = now;
  return { count: entry.times.length, shouldNotify };
}

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

/** True when a stored `publishedData` value is a real immutable snapshot. */
function isPublishedSnapshot(data: unknown): data is Record<string, any> {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, any>;
  return d.schemaVersion === 1 && Array.isArray(d.fields);
}

/** Serialize a serialized field (id, type, label, options, config) into a registry FormField. */
function toRegistryField(f: any): RegistryFormField {
  const safe = isValidFieldType(f?.type) ? f.type : 'text';
  return {
    id: f.id,
    type: safe,
    label: f.label || 'Untitled question',
    required: !!f.required,
    order: typeof f.order === 'number' ? f.order : 0,
    placeholder: typeof f.placeholder === 'string' ? f.placeholder : undefined,
    description: typeof f.description === 'string' ? f.description : undefined,
    ...(Array.isArray(f.options) && f.options.length
      ? { options: f.options.map((o: any) => ({ label: String(o?.label ?? ''), value: String(o?.value ?? o?.label ?? '') })) }
      : {}),
    ...(f.config && typeof f.config === 'object' && Object.keys(f.config).length
      ? { config: normalizeFieldConfig(f.config) as any }
      : {}),
  };
}

/** Serialize a form (with fields + options + pages) into an immutable FormDefinition snapshot. */
function buildPublishedSnapshot(form: any): FormDefinition {
  const settings = (form.settings && typeof form.settings === 'object' ? form.settings : {}) as Record<string, any>;
  const fields: RegistryFormField[] = (form.fields || []).map(toRegistryField);
  const pages = Array.isArray(form.pages) && form.pages.length
    ? form.pages
        .map((p: any) => ({
          id: p.id,
          title: p.title || undefined,
          description: p.description || undefined,
          order: p.order ?? 0,
          fields: (p.fields || []).map(toRegistryField),
        }))
    : undefined;
  return {
    schemaVersion: 1,
    title: form.title || 'Untitled form',
    description: form.description || undefined,
    thankYouMessage: form.thankYouMessage || undefined,
    settings,
    fields,
    ...(pages ? { pages } : {}),
  };
}

/** True when the draft has changes that aren't reflected in the live published version. */
function formHasUnpublishedChanges(form: any): boolean {
  if (!isPublishedSnapshot(form.publishedData)) return false;
  if (form.publishedVersion && (form.publishedVersion ?? 0) <= 0) return false;
  return Boolean(
    form.updatedAt && form.publishedAt &&
    new Date(form.updatedAt).getTime() > new Date(form.publishedAt).getTime()
  );
}

/** Load a form's live draft state (fields + options + pages) for snapshotting. */
function loadDraftSnapshot(formId: string) {
  return prisma.form.findUnique({
    where: { id: formId },
    include: {
      fields: { orderBy: { order: 'asc' }, include: { options: { orderBy: { order: 'asc' } } } },
      pages: { orderBy: { order: 'asc' }, include: { fields: { orderBy: { order: 'asc' }, include: { options: { orderBy: { order: 'asc' } } } } } },
    },
  });
}

/** Serialize a formField (with options) into the shape the forms frontend consumes. */
function serializeFormField(f: any): any {
  const out: any = {
    id: f.id,
    type: f.type,
    label: f.label,
    required: f.required ?? false,
    placeholder: f.placeholder || '',
    order: f.order,
    description: typeof f.description === 'string' ? f.description : undefined,
    options: (f.options || []).map((o: any) => ({ label: o.label, value: o.value || o.label })),
  };
  if (f.config && typeof f.config === 'object' && Object.keys(f.config).length) {
    out.config = normalizeFieldConfig(f.config);
  }
  return out;
}

function scalarValue(v: any): any {
  return Array.isArray(v) ? v.join(', ') : v;
}

/** Serialize a response into the shape the forms frontend consumes. */
function serializeResponse(r: any): any {
  const answersObj: Record<string, any> = {};
  for (const a of r.answers || []) {
    if (a.fieldId) answersObj[a.fieldId] = scalarValue(a.value);
  }
  return {
    id: r.id,
    submittedAt: (r.completedAt || r.createdAt || new Date()).toISOString(),
    respondent: r.respondentName || r.respondentEmail || undefined,
    respondentEmail: r.respondentEmail || undefined,
    duration: r.duration,
    status: r.status,
    answers: answersObj,
  };
}

/** Serialize a single response with field metadata (for the response detail page). */
function serializeResponseDetail(r: any): any {
  return {
    id: r.id,
    respondent: r.respondentName || r.respondentEmail || undefined,
    submittedAt: (r.completedAt || r.createdAt || new Date()).toISOString(),
    duration: r.duration,
    ip: r.ipAddress || undefined,
    userAgent: r.userAgent || undefined,
    answers: (r.answers || []).map((a: any) => ({
      fieldId: a.fieldId,
      fieldLabel: a.field?.label || '',
      fieldType: a.field?.type || '',
      value: scalarValue(a.value),
    })),
    notes: Array.isArray(r.notes)
      ? r.notes.map((n: any) => n.content).filter(Boolean).join('\n')
      : (r.notes || ''),
  };
}

const createFormSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(5000).optional(),
  thankYouMessage: z.string().max(1000).optional(),
  allowCollaboratorEdits: z.boolean().optional(),
  fields: z.array(z.object({
    id: z.string().max(100).optional(),
    type: z.string().max(50),
    label: z.string().min(1).max(500),
    required: z.boolean().optional(),
    order: z.number().int().min(0).max(1000).optional(),
    placeholder: z.string().max(500).optional(),
    description: z.string().max(2000).optional(),
    options: z.array(z.object({
      label: z.string().max(500),
      value: z.string().max(500).optional(),
    })).max(100).optional(),
  })).max(200).optional(),
});

const updateFormSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).optional(),
  status: z.enum(['draft', 'published', 'archived', 'closed']).optional(),
  visibility: z.enum(['public', 'unlisted', 'private']).optional(),
  loginRequired: z.boolean().optional(),
  captchaEnabled: z.boolean().optional(),
  rateLimit: z.number().int().min(1).max(10000).optional(),
  limitPerUser: z.number().int().min(1).max(1000).optional(),
  responseLimit: z.number().int().min(1).max(1000000).optional(),
  expiresAt: z.string().datetime().optional(),
  scheduledAt: z.string().datetime().optional(),
  closeAt: z.string().datetime().optional(),
  openMessage: z.string().max(1000).optional(),
  thankYouMessage: z.string().max(1000).optional(),
  allowCollaboratorEdits: z.boolean().optional(),
  closeMessage: z.string().max(1000).optional(),
  redirectUrl: z.string().url().max(2000).optional(),
  collectEmail: z.boolean().optional(),
  confirmBeforeSubmit: z.boolean().optional(),
  showProgressBar: z.boolean().optional(),
  shuffleFields: z.boolean().optional(),
  allowEdit: z.boolean().optional(),
  allowDelete: z.boolean().optional(),
  color: z.string().max(20).optional(),
  fontSize: z.string().max(20).optional(),
  layout: z.string().max(20).optional(),
  coverImage: z.string().max(10000).optional(),
  slug: z.string().max(200).optional(),
  customDomain: z.string().max(200).optional(),
  seoTitle: z.string().max(200).optional(),
  seoDescription: z.string().max(500).optional(),
  fields: z.array(z.object({
    id: z.string().max(100),
    type: z.string().max(50).refine(v => isValidFieldType(v), { message: 'Unknown field type' }),
    label: z.string().min(1).max(500),
    required: z.boolean().optional(),
    order: z.number().int().min(0).max(1000),
    placeholder: z.string().max(500).optional(),
    description: z.string().max(2000).optional(),
    config: z.record(z.string(), z.any()).optional(),
    options: z.array(z.object({
      label: z.string().max(500),
      value: z.string().max(500),
    })).max(100).optional(),
  })).max(200).optional(),
});

function generatePublicId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

async function getUserId(req: NextRequest): Promise<string | null> {
  const session = await getSession(req);
  return session?.userId || null;
}

/** True when the user owns the form or is an editor/admin collaborator. */
async function canAccessForm(userId: string, formId: string): Promise<boolean> {
  const resolvedId = await resolveFormId(formId);
  const form = await prisma.form.findUnique({ where: { id: resolvedId }, select: { id: true, ownerId: true } });
  if (!form) return false;
  if (form.ownerId === userId) return true;
  return !!(await prisma.formCollaborator.findFirst({
    where: { formId: resolvedId, userId, role: { in: ['editor', 'admin'] } },
  }));
}

/** Resolve a formId that may be a publicId to its internal UUID. */
async function resolveFormId(formId: string): Promise<string> {
  const byPublic = await prisma.form.findUnique({ where: { publicId: formId }, select: { id: true } });
  return byPublic?.id || formId;
}

/** True when the user can access the form a response belongs to. */
async function canAccessResponse(userId: string, responseId: string): Promise<boolean> {
  const response = await prisma.response.findUnique({ where: { id: responseId }, select: { formId: true } });
  if (!response) return false;
  return canAccessForm(userId, response.formId);
}

export async function listForms(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const search = searchParams.get('search');
  const page = parseInt(searchParams.get('page') || '1');
  const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
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
    withRetry(() => prisma.form.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit,
      include: {
        _count: { select: { fields: true, responses: true } },
        user: { select: { id: true, name: true, email: true, photoUrl: true } },
      },
    })),
    withRetry(() => prisma.form.count({ where })),
  ]);

  // Normalize the response so the frontend gets consistent data
  const normalized = forms.map(f => ({
    ...f,
    fieldCount: f._count.fields,
    responseCount: f.responseCount || f._count.responses,
    createdBy: f.user,
  }));

  return NextResponse.json({ forms: normalized, total, page, limit });
}

export async function listMyResponses(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const session = await getSession(req);
  const email = session?.email || '';
  if (!email) return NextResponse.json({ forms: [] });

  const grouped = await withRetry(() => prisma.response.groupBy({
    by: ['formId'],
    where: {
      respondentEmail: { equals: email, mode: 'insensitive' },
      status: 'completed',
    },
    _count: { _all: true },
    _max: { createdAt: true },
  }));

  const formIds = grouped.map(g => g.formId);
  const forms = formIds.length
    ? await prisma.form.findMany({
        where: { id: { in: formIds } },
        select: {
          id: true,
          title: true,
          description: true,
          publicId: true,
          status: true,
          responseCount: true,
          updatedAt: true,
        },
      })
    : [];

  const byId = new Map(forms.map(f => [f.id, f]));
  const result = grouped
    .map(g => {
      const form = byId.get(g.formId);
      if (!form) return null;
      return {
        id: form.id,
        title: form.title,
        description: form.description || '',
        publicId: form.publicId,
        status: form.status,
        responseCount: form.responseCount,
        mySubmissions: g._count._all,
        lastSubmittedAt: g._max.createdAt?.toISOString() || new Date().toISOString(),
        updatedAt: form.updatedAt,
      };
    })
    .filter((f): f is NonNullable<typeof f> => !!f);

  result.sort((a, b) => (a.lastSubmittedAt < b.lastSubmittedAt ? 1 : -1));

  return NextResponse.json({ forms: result });
}

export async function createForm(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const body: any = await req.json();
  const parsed = createFormSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid form data', fields: parsed.error.flatten().fieldErrors } }, { status: 400 });
  }

  // Sanitize title and description
  const title = sanitizeInput(parsed.data.title, 255);
  const description = parsed.data.description ? sanitizeInput(parsed.data.description, 5000) : undefined;
  const thankYouMessage = parsed.data.thankYouMessage ? sanitizeInput(parsed.data.thankYouMessage, 1000) : undefined;

  // Check for XSS in title and description
  const titleXss = detectXss(title);
  if (titleXss) {
    return NextResponse.json({ error: { code: 'INVALID_INPUT', message: `Invalid content in title: ${titleXss}` } }, { status: 400 });
  }
  if (description) {
    const descXss = detectXss(description);
    if (descXss) {
      return NextResponse.json({ error: { code: 'INVALID_INPUT', message: `Invalid content in description: ${descXss}` } }, { status: 400 });
    }
  }

  const form = await withRetry(() => prisma.form.create({
    data: {
      title,
      description,
      ownerId: userId,
      publicId: generatePublicId(),
      status: 'draft',
      thankYouMessage,
      allowCollaboratorEdits: parsed.data.allowCollaboratorEdits ?? false,
    },
  }));

  // Create fields if provided with sanitized labels
  if (parsed.data.fields && parsed.data.fields.length > 0) {
    for (let i = 0; i < parsed.data.fields.length; i++) {
      const f = parsed.data.fields[i];
      const fieldLabel = sanitizeInput(f.label, 500);
      const fieldPlaceholder = f.placeholder ? sanitizeInput(f.placeholder, 500) : undefined;
      const fieldDescription = f.description ? sanitizeInput(f.description, 2000) : undefined;

      // Check for XSS in field label
      const labelXss = detectXss(fieldLabel);
      if (labelXss) {
        return NextResponse.json({ error: { code: 'INVALID_INPUT', message: `Invalid content in field label: ${labelXss}` } }, { status: 400 });
      }

      const field = await prisma.formField.create({
        data: {
          formId: form.id,
          type: sanitizeInput(f.type, 50),
          label: fieldLabel,
          required: f.required || false,
          order: f.order ?? i,
          placeholder: fieldPlaceholder,
        },
      });
      if (f.options && f.options.length > 0) {
        await prisma.formFieldOption.createMany({
          data: f.options.map((o, j) => ({
            fieldId: field.id,
            label: sanitizeInput(o.label, 500),
            value: o.value ? sanitizeInput(o.value, 500) : sanitizeInput(o.label, 500),
            order: j,
          })),
          skipDuplicates: true,
        });
      }
    }
  }

  // Award karma points for creating a form
  await prisma.user.update({
    where: { id: userId },
    data: { karmaPoints: { increment: 10 } },
  }).catch(() => {});

  // Log activity event
  createAuditEvent({
    actorId: userId,
    action: 'FORM_CREATED',
    targetType: 'form',
    targetId: form.id,
    metadata: { title: form.title, status: form.status, fieldCount: parsed.data.fields?.length || 0 },
  }).catch(() => {});

  return NextResponse.json(form, { status: 201 });
}

// ─── POST /api/forms/import ────────────────────────────── Create a form from JSON
const importFieldSchema = z.object({
  id: z.string().max(100).optional(),
  type: z.string().max(50).refine(v => isValidFieldType(v), { message: 'Unknown field type' }),
  label: z.string().min(1).max(500),
  required: z.boolean().optional(),
  order: z.number().int().min(0).max(1000).optional(),
  placeholder: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  config: z.record(z.string(), z.any()).optional(),
  options: z.array(z.object({ label: z.string().max(500), value: z.string().max(500).optional() })).max(100).optional(),
});
const importFormSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(5000).optional(),
  thankYouMessage: z.string().max(1000).optional(),
  fields: z.array(importFieldSchema).min(1).max(200),
});

export async function importForm(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  const body: any = await req.json();
  const parsed = importFormSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid form JSON', fields: parsed.error.flatten().fieldErrors } }, { status: 400 });
  }

  const data = parsed.data;

  // Sanitize title and description
  const title = sanitizeInput(data.title, 255);
  const description = data.description ? sanitizeInput(data.description, 5000) : undefined;
  const thankYouMessage = data.thankYouMessage ? sanitizeInput(data.thankYouMessage, 1000) : undefined;

  // Check for XSS
  const titleXss = detectXss(title);
  if (titleXss) {
    return NextResponse.json({ error: { code: 'INVALID_INPUT', message: `Invalid content in title: ${titleXss}` } }, { status: 400 });
  }

  const form = await prisma.form.create({
    data: {
      title,
      description,
      ownerId: userId,
      publicId: generatePublicId(),
      status: 'draft',
      thankYouMessage,
    },
  });

  const createdFields: any[] = [];
  for (let i = 0; i < data.fields.length; i++) {
    const f = data.fields[i];
    const fieldLabel = sanitizeInput(f.label, 500);
    const fieldPlaceholder = f.placeholder ? sanitizeInput(f.placeholder, 500) : undefined;
    const fieldDescription = f.description ? sanitizeInput(f.description, 2000) : undefined;

    // Check for XSS
    const labelXss = detectXss(fieldLabel);
    if (labelXss) {
      return NextResponse.json({ error: { code: 'INVALID_INPUT', message: `Invalid content in field label: ${labelXss}` } }, { status: 400 });
    }

    const field = await prisma.formField.create({
      data: {
        formId: form.id,
        type: f.type,
        label: fieldLabel,
        placeholder: fieldPlaceholder,
        description: fieldDescription,
        required: !!f.required,
        order: f.order ?? i,
        ...(f.config && typeof f.config === 'object' ? { config: normalizeFieldConfig(f.config) as any } : {}),
      },
    });
    if (f.options && f.options.length > 0) {
      await prisma.formFieldOption.createMany({
        data: f.options.map((o, j) => ({
          fieldId: field.id,
          label: sanitizeInput(o.label, 500),
          value: o.value ? sanitizeInput(o.value, 500) : sanitizeInput(o.label, 500),
          order: j,
        })),
        skipDuplicates: true,
      });
    }
    createdFields.push({ ...field, options: f.options || [] });
  }

  void prisma.user.update({ where: { id: userId }, data: { karmaPoints: { increment: 10 } } }).catch(() => {});

  return NextResponse.json({ ...form, fieldCount: createdFields.length, fields: createdFields }, { status: 201 });
}



export async function getForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  // Resolve by publicId first, then by internal id
  let resolvedFormId = formId;
  const byPublic = await prisma.form.findUnique({ where: { publicId: formId }, select: { id: true } });
  if (byPublic) resolvedFormId = byPublic.id;

  const form = await withRetry(() => prisma.form.findFirst({
    where: {
      id: resolvedFormId,
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
  }));

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });
  const merged = withSettings(form);
  // Fallback for forms whose fields were previously saved only inside settings JSON.
  if ((!merged.fields || merged.fields.length === 0) && Array.isArray((merged.settings as any)?.fields)) {
    merged.fields = (merged.settings as any).fields;
  }
  // Versioned-publish metadata the builder needs to show draft/live state.
  merged.publishedVersion = form.publishedVersion ?? 0;
  merged.hasUnpublishedChanges = formHasUnpublishedChanges(form);
  merged.publishedAt = form.publishedAt;
  return NextResponse.json(merged);
}

export async function updateForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);

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

  const body: any = await req.json();
  const parsed = updateFormSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Invalid form data', fields: parsed.error.flatten().fieldErrors } }, { status: 400 });
  }

  const { fields, ...formData } = parsed.data;

  // Sanitize title and description if provided
  if (formData.title) {
    const titleXss = detectXss(formData.title);
    if (titleXss) {
      return NextResponse.json({ error: { code: 'INVALID_INPUT', message: `Invalid content in title: ${titleXss}` } }, { status: 400 });
    }
    formData.title = sanitizeInput(formData.title, 255);
  }
  if (formData.description) {
    const descXss = detectXss(formData.description);
    if (descXss) {
      return NextResponse.json({ error: { code: 'INVALID_INPUT', message: `Invalid content in description: ${descXss}` } }, { status: 400 });
    }
    formData.description = sanitizeInput(formData.description, 5000);
  }

  if (fields && formId) {
    try {
      const existingFieldIds = await prisma.formField.findMany({ where: { formId }, select: { id: true } });
      if (existingFieldIds.length > 0) {
        const fieldIds = existingFieldIds.map(f => f.id);
        await prisma.formFieldOption.deleteMany({ where: { fieldId: { in: fieldIds } } }).catch(() => {});
        await prisma.formField.deleteMany({ where: { id: { in: fieldIds } } }).catch(() => {});
      }
    } catch (e: any) {
      console.error('[FORM] Failed to clear existing fields:', e?.message);
    }
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const { options, ...fieldData } = f;

      // Sanitize field data
      const fieldLabel = sanitizeInput(fieldData.label, 500);
      const fieldPlaceholder = fieldData.placeholder ? sanitizeInput(fieldData.placeholder, 500) : undefined;
      const fieldDescription = fieldData.description ? sanitizeInput(fieldData.description, 2000) : undefined;
      const fieldType = isValidFieldType(fieldData.type) ? fieldData.type : 'text';

      // Check for XSS
      const labelXss = detectXss(fieldLabel);
      if (labelXss) {
        return NextResponse.json({ error: { code: 'INVALID_INPUT', message: `Invalid content in field label: ${labelXss}` } }, { status: 400 });
      }

      const created = await prisma.formField.create({
        data: {
          formId,
          type: fieldType,
          label: fieldLabel,
          required: fieldData.required || false,
          order: fieldData.order,
          placeholder: fieldPlaceholder,
          description: fieldDescription,
          ...(fieldData.config && typeof fieldData.config === 'object'
            ? { config: normalizeFieldConfig(fieldData.config) as any }
            : {}),
        },
      });
      if (options && options.length > 0) {
        await prisma.formFieldOption.createMany({
          data: options.map((o, oi) => ({
            fieldId: created.id,
            label: sanitizeInput(o.label, 500),
            value: sanitizeInput(o.value, 500),
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

  // Snapshot the whole draft (fields + pages + settings) as a versioned draft.
  const draftFull = await loadDraftSnapshot(formId);
  const draftSnapshot = draftFull ? buildPublishedSnapshot(draftFull) : undefined;
  await prisma.formVersion.create({
    data: {
      formId,
      version: (form.versions?.[0]?.version || 0) + 1,
      type: 'draft',
      data: (draftSnapshot || updated) as any,
      createdBy: userId,
    },
  });

  // Log activity event
  createAuditEvent({
    actorId: userId,
    action: 'FORM_UPDATED',
    targetType: 'form',
    targetId: formId,
    metadata: { title: updated.title, fieldsUpdated: fields ? fields.length : 0 },
  }).catch(() => {});

  const resp = { ...updated, hasUnpublishedChanges: formHasUnpublishedChanges({ ...updated, publishedData: form.publishedData }) };
  return NextResponse.json(resp);
}

export async function deleteForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);

  const form = await prisma.form.findFirst({
    where: { id: formId, ownerId: userId },
  });

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  // Log activity event before deletion
  createAuditEvent({
    actorId: userId,
    action: 'FORM_DELETED',
    targetType: 'form',
    targetId: formId,
    metadata: { title: form.title },
  }).catch(() => {});

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
  formId = await resolveFormId(formId);

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

  // Serialize the current draft into an immutable snapshot. Publishing never
  // mutates an old snapshot: it writes a new one, so the live form stays stable
  // while the owner keeps editing a fresh draft.
  const draft = await loadDraftSnapshot(formId);
  const snapshot: FormDefinition = buildPublishedSnapshot(draft || form);
  const nextVersion = (form.versions?.[0]?.version || 0) + 1;
  const publishedVersion = (form.publishedVersion ?? 0) + 1;

  const updated = await prisma.$transaction([
    prisma.form.update({
      where: { id: formId },
      data: {
        status: 'published',
        publishedAt: new Date(),
        publishedData: snapshot as any,
        publishedVersion,
      },
    }),
    prisma.formVersion.create({
      data: {
        formId,
        version: nextVersion,
        type: 'published',
        data: snapshot as any,
        createdBy: userId,
      },
    }),
  ]);

  // Log activity event
  createAuditEvent({
    actorId: userId,
    action: 'FORM_PUBLISHED',
    targetType: 'form',
    targetId: formId,
    metadata: { title: form.title, publicId: form.publicId, publishedVersion },
  }).catch(() => {});

  const owner = await prisma.user.findUnique({ where: { id: form.ownerId }, select: { email: true } });
  if (owner?.email) {
    await sendFormLifecycleEmail(owner.email, form, {
      badge: 'Published',
      title: 'Your form is now live',
      subtitle: `Live version v${publishedVersion} is now accepting responses`,
      body: `Anyone with the link can now view and fill out your form. Share it to start collecting responses right away.`,
      details: [{ label: 'Live version', value: `v${publishedVersion}` }, { label: 'Published', value: new Date().toLocaleString() }],
      cta: { url: `${process.env.FORMS_URL || 'https://forms.tirbeo.app'}/f/${form.publicId}`, label: 'View form' },
      subject: `Your form "${form.title || 'Untitled Form'}" is now live (v${publishedVersion})`,
    }, 'form_published');
  }

  return NextResponse.json({
    ...updated[0],
    publishedVersion,
    hasUnpublishedChanges: false,
  });
}

export async function archiveForm(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);

  const form = await prisma.form.findFirst({
    where: { id: formId, ownerId: userId },
  });

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const updated = await prisma.form.update({
    where: { id: formId },
    data: { status: 'archived' },
  });

  // Log activity event
  createAuditEvent({
    actorId: userId,
    action: 'FORM_ARCHIVED',
    targetType: 'form',
    targetId: formId,
    metadata: { title: form.title },
  }).catch(() => {});

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
  const form = await withRetry(() => prisma.form.findUnique({
    where: { publicId },
    select: {
      id: true,
      ownerId: true,
      publicId: true,
      title: true,
      description: true,
      thankYouMessage: true,
      status: true,
      captchaEnabled: true,
      settings: true,
      publishedData: true,
      publishedVersion: true,
      publishedAt: true,
      updatedAt: true,
      responseCount: true,
      viewCount: true,
      fields: { orderBy: { order: 'asc' }, include: { options: { orderBy: { order: 'asc' } } } },
      pages: { orderBy: { order: 'asc' }, include: { fields: { orderBy: { order: 'asc' } } } },
    },
  }));

  if (!form) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });
  }

  // Drafts/archived forms are private, but the owner (and editor/admin
  // collaborators) may preview them via the share link. Everyone else sees 404.
  const isPublic = form.status === 'published';
  if (!isPublic) {
    const userId = await getUserId(req);
    if (!userId || !(await canAccessForm(userId, form.id))) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found or not yet published' } }, { status: 404 });
    }
  }

  // Only count a view for genuine public traffic, not owner previews.
  if (isPublic) {
    await withRetry(() => prisma.form.update({
      where: { id: form.id },
      data: { viewCount: { increment: 1 } },
    }));
  }

  // Immutable path: serve the last published snapshot verbatim. Editing the
  // draft never mutates this, so the live form stays stable for respondents.
  let snapshot: any = null;
  if (isPublishedSnapshot(form.publishedData)) {
    snapshot = form.publishedData as any;
  }

  const live: any = withSettings(form);
  const merged = {
    id: form.id,
    publicId: form.publicId,
    title: snapshot?.title ?? live.title,
    description: snapshot?.description ?? live.description,
    thankYouMessage: snapshot?.thankYouMessage ?? live.thankYouMessage,
    status: form.status,
    captchaEnabled: live.captchaEnabled,
    publishedVersion: form.publishedVersion ?? 0,
    hasUnpublishedChanges: formHasUnpublishedChanges(form),
    responseCount: form.responseCount,
    viewCount: form.viewCount,
    source: (form as any).source || (live.source || 'user'),
    // Immutable fields when a snapshot exists; otherwise fall back to the live
    // draft (legacy forms published before versioning was introduced).
    fields: snapshot?.fields ?? live.fields ?? [],
    pages: snapshot?.pages?.length ? snapshot.pages : (live.pages?.length ? live.pages : undefined),
    ...live.settings,
  };

  // Backward-compat: previously some forms stored fields inside settings JSON.
  if ((!merged.fields || merged.fields.length === 0) && Array.isArray(live.settings?.fields)) {
    merged.fields = live.settings.fields;
  }

  // Respondents experience the *published* logic rules (immutable snapshot),
  // never the newer draft rules.
  const snapshotSettings = snapshot?.settings && typeof snapshot.settings === 'object' ? snapshot.settings : null;
  if (snapshotSettings && Array.isArray(snapshotSettings.logicRules)) {
    merged.logicRules = snapshotSettings.logicRules;
  } else if (!merged.logicRules && live.settings?.logicRules) {
    merged.logicRules = live.settings.logicRules;
  }

  // Time window: the owner can schedule the form to stop accepting responses.
  const closeRaw = live.settings?.closeDate;
  const closeAt = typeof closeRaw === 'string' && closeRaw ? new Date(closeRaw) : null;
  const closed = isPublic && closeAt && !Number.isNaN(closeAt.getTime()) && closeAt.getTime() <= Date.now();
  merged.closed = Boolean(closed);
  merged.closeMessage = closed
    ? (typeof live.settings?.closeMessage === 'string' ? live.settings.closeMessage : undefined)
    : undefined;

  return NextResponse.json(merged);
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
    `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;"><tr><td style="padding:14px 16px;border:2px solid ${c.border};border-radius:8px;"><p style="margin:0;font-size:12px;line-height:20px;color:${c.textMuted};"><strong style="color:${c.text};">Submitted:</strong> ${submittedAt} · <strong style="color:${c.text};">ID:</strong> ${responseId.slice(0, 8)}</p></td></tr></table>` +
    `<p style="margin:22px 0 0;font-size:12px;line-height:20px;color:${c.textMuted};">If you didn't submit this form, you can safely ignore this email.</p>` +
    `</td></tr>` +
    // Footer
    `<tr><td style="padding:20px 40px;border-top:2px solid ${c.border};text-align:center;background:${c.surface};"><p style="margin:0;font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${c.accent};">Tirbeo Forms</p><p style="margin:8px 0 0;font-size:11px;line-height:18px;color:${c.textMuted};">Powered by Tirbeo · <a href="https://tirbeo.app/privacy" style="color:${c.accent};">Privacy</a> · <a href="https://tirbeo.app/terms" style="color:${c.accent};">Terms</a></p></td></tr>` +
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
    `<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:14px 16px;border:2px solid ${c.border};border-radius:8px;"><p style="margin:0;font-size:13px;line-height:22px;color:${c.textMuted};"><strong style="color:${c.text};">Respondent:</strong> ${respondentName} (${respondentEmail})</p><p style="margin:6px 0 0;font-size:13px;line-height:22px;color:${c.textMuted};"><strong style="color:${c.text};">Submitted:</strong> ${submittedAt} · <strong style="color:${c.text};">ID:</strong> ${response.id.slice(0, 8)}</p></td></tr></table>` +
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
  const form = await withRetry(() => prisma.form.findUnique({
    where: { publicId },
    include: { fields: true },
  }));

  if (!form) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });
  }
  // Submissions are only accepted on live published forms.
  if (form.status !== 'published') {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found or not yet published' } }, { status: 404 });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';
  const session = await getSession(req);
  const userId = session?.userId || null;
  const settings = (form.settings as any) || {};

  // Login-required forms must have a valid session.
  if (settings.loginRequired && !session?.userId) {
    return NextResponse.json({ error: { code: 'LOGIN_REQUIRED', message: 'This form requires you to sign in before responding' } }, { status: 401 });
  }

  // Optional hard cap on total responses.
  const limit = typeof settings.responseLimit === 'number' && settings.responseLimit > 0 ? settings.responseLimit : null;
  if (limit !== null && form.responseCount >= limit) {
    return NextResponse.json({ error: { code: 'LIMIT_REACHED', message: 'This form has reached its response limit' } }, { status: 403 });
  }

  // Time window: reject once the scheduled close date has passed.
  const closeRaw = settings.closeDate;
  const closeAt = typeof closeRaw === 'string' && closeRaw ? new Date(closeRaw) : null;
  if (closeAt && !Number.isNaN(closeAt.getTime()) && closeAt.getTime() <= Date.now()) {
    return NextResponse.json({
      error: { code: 'FORM_CLOSED', message: typeof settings.closeMessage === 'string' && settings.closeMessage ? settings.closeMessage : 'This form is no longer accepting responses.' },
    }, { status: 403 });
  }

  // Check IP blocklist
  const { isIpBlocked } = await import('./security');
  if (await isIpBlocked(ip)) {
    return NextResponse.json({ error: { code: 'BLOCKED', message: 'Your IP address has been blocked' } }, { status: 403 });
  }

  // Rate limiting check
  const rateLimitResult = checkSubmissionRateLimit(form.id, ip, (form.settings as any)?.rateLimit);
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      {
        error: { code: 'RATE_LIMITED', message: 'Too many submissions. Please try again later.' },
        resetAt: rateLimitResult.resetAt.toISOString(),
      },
      { status: 429 }
    );
  }

  const body: any = await req.json();

  // Name is required when the form asks for it.
  if (settings.requireName && (!body.respondentName || !String(body.respondentName).trim())) {
    return NextResponse.json({ error: { code: 'NAME_REQUIRED', message: 'Your name is required' } }, { status: 400 });
  }

  // Per-respondent limit: count prior submissions from the same email, or the
  // same IP when the respondent is anonymous.
  const perUserLimit = typeof settings.limitPerUser === 'number' && settings.limitPerUser > 0 ? settings.limitPerUser : null;
  if (perUserLimit !== null) {
    const email = typeof body.respondentEmail === 'string' ? String(body.respondentEmail).trim().toLowerCase() : '';
    const priorCount = email
      ? await prisma.response.count({ where: { formId: form.id, respondentEmail: { equals: email, mode: 'insensitive' } } })
      : await prisma.response.count({ where: { formId: form.id, ipAddress: ip } });
    if (priorCount >= perUserLimit) {
      return NextResponse.json({ error: { code: 'LIMIT_REACHED', message: 'You have reached the submission limit for this form' } }, { status: 403 });
    }
  }

  // Validate against the immutable published schema (fall back to the live
  // draft for legacy forms published before versioning existed).
  const publishedSnapshot = isPublishedSnapshot(form.publishedData) ? (form.publishedData as any) : null;
  const publishedFields = publishedSnapshot ? publishedSnapshot.fields : (form.fields || []);
  const publishedSettings = (publishedSnapshot?.settings && typeof publishedSnapshot.settings === 'object' ? publishedSnapshot.settings : {}) as Record<string, any>;
  const validation = validateSubmission(
    { fields: publishedFields, logicRules: publishedSettings.logicRules },
    body,
  );
  if (!validation.valid) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: validation.error } }, { status: 400 });
  }

  // Automatic anti-spam: honest visitors are "auto-solved"; sustained bursts
  // require a CAPTCHA challenge, and severe bursts are blocked outright.
  const burst = checkSubmissionBurst(form.id, ip);
  if (burst.level === 'block') {
    return NextResponse.json(
      {
        error: { code: 'RATE_LIMITED', message: 'Too many submissions from this address. Please try again later.' },
        retryAfter: burst.retryAfter || 60,
      },
      { status: 429 }
    );
  }
  if (burst.level === 'captcha') {
    const captchaSettings = await getCaptchaSettings();
    if (captchaSettings.enabled) {
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
        // A failed human check while rate-limited — flag the owner with a themed email.
        await notifyFormFlagged(form, { rayId: captchaRayId, reason: check.error, ip });
        return NextResponse.json({ error: { code: 'CAPTCHA_FAILED', message: check.error || 'CAPTCHA verification failed' } }, { status: 403 });
      }
    }
  }

  // Sanitize and validate answers
  const { sanitized: cleanAnswers, threats } = sanitizeSubmissionAnswers(body.answers || {});
  if (threats.length > 0) {
    console.warn(`[SECURITY] Form submission threats detected for form ${form.id}:`, threats);
    // Log security event but don't block - the input is already sanitized
  }

  // Additional input sanitization for respondent info
  const respondentEmail = body.respondentEmail ? sanitizeInput(String(body.respondentEmail), 254) : undefined;
  const respondentName = body.respondentName ? sanitizeInput(String(body.respondentName), 200) : undefined;

  // Check for XSS in respondent info
  if (respondentEmail) {
    const emailXss = detectXss(respondentEmail);
    if (emailXss) {
      return NextResponse.json({ error: { code: 'INVALID_INPUT', message: 'Invalid email address' } }, { status: 400 });
    }
  }
  if (respondentName) {
    const nameXss = detectXss(respondentName);
    if (nameXss) {
      return NextResponse.json({ error: { code: 'INVALID_INPUT', message: 'Invalid name' } }, { status: 400 });
    }
  }

  const liveVersion = await prisma.formVersion.findFirst({
    where: { formId: form.id, type: 'published' },
    orderBy: { version: 'desc' },
    select: { id: true },
  });

  const response = await prisma.response.create({
    data: {
      formId: form.id,
      versionId: liveVersion?.id || null,
      respondentEmail,
      respondentName,
      ipAddress: ip,
      userAgent: userAgent,
      status: 'completed',
      completedAt: new Date(),
      answers: { create: Object.entries(cleanAnswers).map(([fieldId, value]) => ({ fieldId, value: value as any })) },
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

  // Award karma points to form owner for receiving a response
  await prisma.user.update({
    where: { id: form.ownerId },
    data: { karmaPoints: { increment: 2 } },
  }).catch(() => {});

  // Log activity event (using form owner as actor since respondent may not be authenticated)
  createAuditEvent({
    actorId: form.ownerId,
    action: 'FORM_RESPONSE_SUBMITTED',
    targetType: 'form',
    targetId: form.id,
    metadata: { responseId: response.id, respondentEmail: body.respondentEmail || null, respondentName: body.respondentName || null, threats },
  }).catch(() => {});

  // Deliver configured webhooks out-of-band so a slow receiver never delays the submit.
  if (settings.webhookUrl) {
    void sendFormWebhook(
      form,
      response.id,
      publishedFields,
      cleanAnswers,
      { name: respondentName, email: respondentEmail },
      ip,
    ).catch(() => {});
  }

  try {
    const owner = await prisma.user.findUnique({ where: { id: form.ownerId } });
    if (owner?.email) {
      const notif = (settings.notificationChannels as any) || {};
      const notifyEmail = notif.email !== false;
      const isDormant = !form.lastSubmissionAt || Date.now() - new Date(form.lastSubmissionAt).getTime() > DORMANT_DAYS * 86400000;

      if (notifyEmail) {
        if (isDormant) {
          // First response in a long time — flag it so the owner reacts.
          const gapDays = form.lastSubmissionAt
            ? Math.max(1, Math.floor((Date.now() - new Date(form.lastSubmissionAt).getTime()) / 86400000))
            : null;
          const revived = buildThemedFormLifecycleEmail(form, {
            badge: 'Revived',
            title: 'Your form just got a new response',
            subtitle: 'After a quiet stretch, someone responded to',
            intro: gapDays ? `It had been ${gapDays} day${gapDays === 1 ? '' : 's'} since the last submission.` : 'This is the first response your form has received.',
            body: `${escapeHtml(body.respondentName?.trim() || 'A respondent')} just submitted "${form.title}". Review the answers and keep the momentum going.`,
            details: [
              { label: 'Respondent', value: body.respondentName?.trim() || 'Anonymous' },
              ...(body.respondentEmail ? [{ label: 'Email', value: body.respondentEmail }] : []),
              { label: 'Response ID', value: response.id.slice(0, 8) },
            ],
            cta: { url: `${process.env.ADMIN_URL || 'https://admin.tirbeo.app'}/forms/${form.id}/responses`, label: 'View responses' },
            subject: `Your form "${form.title || 'Untitled Form'}" is getting responses again`,
          });
          await sendEmail(owner.email, revived.subject, revived.html, {
            fromEmail: 'forms@send.tirbeo.app',
            fromName: 'Tirbeo Forms',
            templateName: 'form_revival',
          });
        } else {
          const themed = buildFormOwnerEmail(form, response, { ...body, answers: cleanAnswers });
          await sendEmail(owner.email, themed.subject, themed.html, {
            fromEmail: 'forms@send.tirbeo.app',
            fromName: 'Tirbeo Forms',
            templateName: 'form_response',
          });
        }
      }

      // Activity spike — several responses arriving close together.
      const spike = trackFormSpike(form.id);
      if (spike.shouldNotify) {
        const spikeEmail = buildThemedFormLifecycleEmail(form, {
          badge: 'Activity spike',
          title: `${spike.count} responses in the last 10 minutes`,
          subtitle: 'Your form is seeing a burst of submissions —',
          body: `"${form.title}" has received ${spike.count} responses in the last ten minutes. This is a great moment to check the responses tab.`,
          details: [
            { label: 'Responses (10 min)', value: String(spike.count) },
            { label: 'Total responses', value: String((form.responseCount || 0) + 1) },
          ],
          cta: { url: `${process.env.ADMIN_URL || 'https://admin.tirbeo.app'}/forms/${form.id}/responses`, label: 'View responses' },
          subject: `Spike in responses to "${form.title || 'Untitled Form'}"`,
        });
        await sendEmail(owner.email, spikeEmail.subject, spikeEmail.html, {
          fromEmail: 'forms@send.tirbeo.app',
          fromName: 'Tirbeo Forms',
          templateName: 'form_spike',
        });
        createAuditEvent({
          actorId: form.ownerId,
          action: 'FORM_RESPONSE_SPIKE_NOTIFIED',
          targetType: 'form',
          targetId: form.id,
          metadata: { count: spike.count, windowMs: BOOM_WINDOW_MS },
        }).catch(() => {});
      }
    }
  } catch (e: any) {
    console.error('[EMAIL] Failed to send form response notification:', e?.message);
  }

  // Confirm to the respondent — prefer an explicitly submitted email, then fall
  // back to the logged-in user's account email so signed-in responders get a copy.
  let confirmEmail = body.respondentEmail;
  if (!confirmEmail && session?.userId) {
    const respondentUser = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } });
    confirmEmail = respondentUser?.email || undefined;
  }
  if (confirmEmail) {
    try {
      const themed = buildFormConfirmationEmail(form, response.id, { ...body, answers: cleanAnswers });
      await sendEmail(confirmEmail, themed.subject, themed.html, {
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
  formId = await resolveFormId(formId);

  if (!(await canAccessForm(userId, formId))) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get('page') || '1');
  const perPage = Math.min(parseInt(searchParams.get('perPage') || searchParams.get('limit') || '50'), 200);
  const skip = (page - 1) * perPage;
  const sortBy = searchParams.get('sortBy') || 'createdAt';
  const sortOrder = searchParams.get('sortOrder') || 'desc';

  const [form, responses, total] = await Promise.all([
    prisma.form.findUnique({ where: { id: formId }, include: { fields: { include: { options: true }, orderBy: { order: 'asc' } } } }),
    prisma.response.findMany({
      where: { formId },
      orderBy: { [sortBy]: sortOrder },
      skip,
      take: perPage,
      include: { answers: true },
    }),
    prisma.response.count({ where: { formId } }),
  ]);

  return NextResponse.json({
    fields: (form?.fields || []).map(serializeFormField),
    responses: responses.map(serializeResponse),
    total,
    page,
    perPage,
  });
}

export async function getResponse(req: NextRequest, formId: string, responseId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);

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
  return NextResponse.json(serializeResponseDetail(response));
}

export async function deleteResponse(req: NextRequest, formId: string, responseId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);

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

  // Log activity event
  createAuditEvent({
    actorId: userId,
    action: 'FORM_RESPONSE_DELETED',
    targetType: 'form',
    targetId: formId,
    metadata: { responseId, respondentEmail: response.respondentEmail },
  }).catch(() => {});

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
  formId = await resolveFormId(formId);

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

  const body: any = await req.json();
  const { answers, status, notes } = body;

  // Sanitize answers if provided
  let sanitizedAnswers = answers;
  if (answers) {
    const { sanitized, threats } = sanitizeSubmissionAnswers(answers);
    sanitizedAnswers = sanitized;
    if (threats.length > 0) {
      console.warn(`[SECURITY] Response update threats detected for response ${responseId}:`, threats);
    }
  }

  const updated = await prisma.response.update({
    where: { id: responseId },
    data: {
      ...(sanitizedAnswers && { answers: { deleteMany: {}, create: Object.entries(sanitizedAnswers).map(([fieldId, value]) => ({ fieldId, value: value as any })) } }),
      ...(status && { status }),
      ...(notes && { notes: { create: notes.map((n: any) => ({ userId: n.userId, content: sanitizeInput(n.content, 20000) })) } }),
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
  formId = await resolveFormId(formId);

  if (!(await canAccessForm(userId, formId))) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
  }

  // Date range filtering
  const { searchParams } = new URL(req.url);
  const range = searchParams.get('range') || 'all'; // 7d, 30d, 90d, all
  const now = new Date();
  let rangeMs: number | undefined;
  if (range === '7d') rangeMs = 7 * 86400000;
  else if (range === '30d') rangeMs = 30 * 86400000;
  else if (range === '90d') rangeMs = 90 * 86400000;
  const dateFilter = rangeMs ? new Date(now.getTime() - rangeMs) : undefined;

  const whereClause: any = { formId };
  if (dateFilter) whereClause.createdAt = { gte: dateFilter };
  const prevFilter = rangeMs ? { gte: new Date(now.getTime() - rangeMs * 2), lt: dateFilter } : undefined;
  const prevWhere: any = { formId };
  if (prevFilter) prevWhere.createdAt = prevFilter;

  const [form, responses, totalResponses, previousCount, totalAllTime] = await Promise.all([
    prisma.form.findUnique({ where: { id: formId }, include: { fields: { include: { options: true }, orderBy: { order: 'asc' } } } }),
    prisma.response.findMany({
      where: whereClause,
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, duration: true, status: true, userAgent: true, respondentEmail: true, ipAddress: true, answers: true },
    }),
    prisma.response.count({ where: whereClause }),
    prisma.response.count({ where: prevWhere }),
    prisma.response.count({ where: { formId } }),
  ]);

  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const totalViews = form.viewCount || 0;
  const completionRate = totalViews > 0 ? Math.min(100, Math.round((totalResponses / totalViews) * 100)) : 0;

  const durations = responses.map((r) => r.duration).filter((d): d is number => typeof d === 'number');
  const avgDuration = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const startDay = dateFilter || (form.createdAt as Date);
  const daysSpan = Math.max(1, Math.ceil((now.getTime() - new Date(startDay).getTime()) / 86400000));
  const dateRangeLabel = range === 'all' ? 'All time' : `Last ${range}`;

  const submissionsByDay: Record<string, number> = {};
  const submissionTimeline: { date: string; count: number }[] = [];
  const dayCount = Math.min(30, Math.max(7, daysSpan));
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
    submissionTimeline.push({ date: d, count: 0 });
  }
  const timelineByDate = new Map(submissionTimeline.map((t) => [t.date, t]));

  const hourly = new Array(24).fill(0);
  const dow = [0, 0, 0, 0, 0, 0, 0];
  const timeBuckets: { label: string; min: number; max: number }[] = [
    { label: '< 30s', min: 0, max: 30 },
    { label: '30s–1m', min: 30, max: 60 },
    { label: '1–3m', min: 60, max: 180 },
    { label: '3–5m', min: 180, max: 300 },
    { label: '> 5m', min: 300, max: Infinity },
  ];
  const timeCounts = timeBuckets.map(() => 0);
  const devices: Record<string, number> = {};
  const browsers: Record<string, number> = {};
  const oss: Record<string, number> = {};
  const emails = new Set<string>();
  let emailCount = 0;
  let anonymousCount = 0;
  let fieldTotal: Record<string, number> = {};
  const fieldSkip: Record<string, number> = {};
  const fieldAnswerValues: Record<string, any[]> = {};
  const respondentCounts = new Map<string, number>();

  for (const r of responses) {
    const ts = r.createdAt || new Date();
    const key = ts.toISOString().slice(0, 10);
    submissionsByDay[key] = (submissionsByDay[key] || 0) + 1;
    const bucket = timelineByDate.get(key);
    if (bucket) bucket.count += 1;
    hourly[ts.getHours()] += 1;
    dow[ts.getDay()] += 1;

    const dur = r.duration;
    if (typeof dur === 'number') {
      const idx = timeBuckets.findIndex((b) => dur >= b.min && dur < b.max);
      if (idx >= 0) timeCounts[idx] += 1;
    }

    const ua = (r.userAgent || '').toLowerCase();
    if (/mobile|android|iphone|ipad|ipod/i.test(ua)) devices['Mobile'] = (devices['Mobile'] || 0) + 1;
    else if (/tablet|ipad/i.test(ua)) devices['Tablet'] = (devices['Tablet'] || 0) + 1;
    else devices['Desktop'] = (devices['Desktop'] || 0) + 1;

    let browser = 'Other';
    if (/edg\//.test(ua)) browser = 'Edge';
    else if (/opr\//.test(ua)) browser = 'Opera';
    else if (/chrome\//.test(ua)) browser = 'Chrome';
    else if (/firefox\//.test(ua)) browser = 'Firefox';
    else if (/safari\//.test(ua)) browser = 'Safari';
    browsers[browser] = (browsers[browser] || 0) + 1;

    let os = 'Other';
    if (/windows/.test(ua)) os = 'Windows';
    else if (/mac os|macintosh/.test(ua)) os = 'macOS';
    else if (/android/.test(ua)) os = 'Android';
    else if (/iphone|ipad|ipod/.test(ua)) os = 'iOS';
    else if (/linux/.test(ua)) os = 'Linux';
    oss[os] = (oss[os] || 0) + 1;

    const who = r.respondentEmail || 'anonymous';
    if (r.respondentEmail) {
      emailCount += 1;
      emails.add(r.respondentEmail);
    } else {
      anonymousCount += 1;
    }
    respondentCounts.set(who, (respondentCounts.get(who) || 0) + 1);

    for (const a of r.answers || []) {
      if (a.fieldId) {
        fieldTotal[a.fieldId] = (fieldTotal[a.fieldId] || 0) + 1;
        (fieldAnswerValues[a.fieldId] = fieldAnswerValues[a.fieldId] || []).push(a.value);
        if (a.value === null || a.value === '' || (Array.isArray(a.value) && a.value.length === 0)) {
          fieldSkip[a.fieldId] = (fieldSkip[a.fieldId] || 0) + 1;
        }
      }
    }
  }

  const uniqueRespondents = emails.size + (anonymousCount > 0 ? 1 : 0);
  const repeatRespondents = totalResponses > uniqueRespondents ? totalResponses - uniqueRespondents : 0;

  const OTHER_SENTINEL = '__other__';
  const CHOICE_TYPES = new Set(['select', 'radio', 'checkbox', 'multi-select', 'toggle', 'consent', 'terms']);

  const fieldBreakdown = (form.fields || []).map((f) => {
    const total = fieldTotal[f.id] || 0;
    const skipped = fieldSkip[f.id] || 0;
    const raw = fieldAnswerValues[f.id] || [];
    const isChoice = CHOICE_TYPES.has(f.type);
    const dist: Record<string, number> = {};
    const textAnswers: string[] = [];
    for (const v of raw) {
      const vals = Array.isArray(v) ? v : [v];
      for (const val of vals) {
        if (val === null || val === '' || (Array.isArray(val) && val.length === 0)) continue;
        const s = String(val);
        if (isChoice) {
          const opt = (f.options || []).find((o: any) => o.value === s);
          if (opt) dist[opt.label] = (dist[opt.label] || 0) + 1;
          else if (s === OTHER_SENTINEL) dist['Other'] = (dist['Other'] || 0) + 1;
          else textAnswers.push(s);
        } else {
          textAnswers.push(s);
        }
      }
    }
    const seen = new Set<string>();
    const topAnswers = textAnswers
      .map((t) => t.trim())
      .filter((t) => t && !seen.has(t) && seen.add(t))
      .slice(0, 5)
      .map((t) => ({ text: t.length > 100 ? `${t.slice(0, 100)}…` : t, count: textAnswers.filter(x => x.trim() === t).length }));
    const distribution = Object.entries(dist)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
    return {
      fieldId: f.id,
      fieldLabel: f.label,
      fieldType: f.type,
      responses: total,
      skipped,
      completionRate: totalResponses > 0 ? Math.round(((total - skipped) / totalResponses) * 100) : 0,
      distribution,
      topAnswers,
    };
  });

  const toBreakdown = (map: Record<string, number>) =>
    Object.entries(map)
      .map(([name, count]) => ({ name, count, percentage: totalResponses ? Math.round((count / totalResponses) * 100) : 0 }))
      .sort((a, b) => b.count - a.count);

  const deviceBreakdown = toBreakdown(devices).map((e) => ({ device: e.name, count: e.count, percentage: e.percentage }));
  const browserBreakdown = toBreakdown(browsers).map((e) => ({ browser: e.name, count: e.count, percentage: e.percentage }));
  const osBreakdown = toBreakdown(oss).map((e) => ({ os: e.name, count: e.count, percentage: e.percentage }));

  const hourlySubmissions = hourly.map((count, hour) => ({ hour, count }));
  const dayOfWeek = dow.map((count, day) => ({ name: dayNames[day], day, count }));

  const responseTimeDistribution = timeBuckets.map((b, i) => ({ label: b.label, count: timeCounts[i] }));

  const peakHours = hourly
    .map((count, hour) => ({ hour, count }))
    .filter((h) => h.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const submissionsPerDay = Math.round((totalResponses / daysSpan) * 10) / 10;
  const submissionsPerWeek = Math.round((totalResponses / Math.max(1, daysSpan / 7)) * 10) / 10;

  const change = rangeMs ? totalResponses - previousCount : 0;
  const trend = {
    previousCount: rangeMs ? previousCount : 0,
    currentCount: totalResponses,
    change,
    changePercent: rangeMs && previousCount > 0 ? Math.round((change / previousCount) * 100) : (rangeMs && totalResponses > 0 ? 100 : 0),
  };

  return NextResponse.json({
    totalViews,
    totalResponses,
    completionRate,
    avgDuration,
    submissionTimeline,
    submissionsByDay,
    fieldBreakdown,
    deviceBreakdown,
    browserBreakdown,
    osBreakdown,
    hourlySubmissions,
    dayOfWeek,
    responseTimeDistribution,
    emailVsAnonymous: { email: emailCount, anonymous: anonymousCount },
    repeatRespondents,
    uniqueRespondents,
    peakHours,
    submissionsPerDay,
    submissionsPerWeek,
    trend,
    dateRange: dateRangeLabel,
  });
}

// ─── Stub functions for route.ts compatibility ──────────────────────────
// These are minimal implementations to satisfy TypeScript imports.

export async function listCollaborators(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);
  if (!(await canAccessForm(userId, formId))) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
  }
  const collaborators = await prisma.formCollaborator.findMany({
    where: { formId },
    include: { user: { select: { id: true, name: true, email: true, photoUrl: true } } },
  });
  return NextResponse.json({ collaborators });
}

export async function addCollaborator(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);
  const form = await prisma.form.findUnique({ where: { id: formId }, select: { ownerId: true } });
  if (!form || form.ownerId !== userId) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Only the form owner can add collaborators' } }, { status: 403 });
  }
  const body: any = await req.json();
  const { email, role } = body;
  if (!email || !role) {
    return NextResponse.json({ error: { code: 'VALIDATION', message: 'Email and role are required' } }, { status: 400 });
  }
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, { status: 404 });
  }
  const collaborator = await prisma.formCollaborator.upsert({
    where: { formId_userId: { formId, userId: user.id } },
    update: { role },
    create: { formId, userId: user.id, role },
  });
  return NextResponse.json(collaborator, { status: 201 });
}

export async function removeCollaborator(req: NextRequest, formId: string, collaboratorId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);
  const form = await prisma.form.findUnique({ where: { id: formId }, select: { ownerId: true } });
  if (!form || form.ownerId !== userId) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Only the form owner can remove collaborators' } }, { status: 403 });
  }
  await prisma.formCollaborator.delete({ where: { id: collaboratorId } });
  return NextResponse.json({ success: true });
}

export async function listVersions(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);
  if (!(await canAccessForm(userId, formId))) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
  }
  const versions = await prisma.formVersion.findMany({
    where: { formId },
    orderBy: { version: 'desc' },
    take: 50,
  });

  const form = await prisma.form.findUnique({ where: { id: formId }, select: { publishedVersion: true } });
  const publishedVersion = form?.publishedVersion ?? 0;

  // Resolve creator names/emails in one query so the UI can show who saved each revision.
  const creatorIds = [...new Set(versions.map(v => v.createdBy).filter(Boolean))];
  const creators = creatorIds.length
    ? await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true, email: true, photoUrl: true } })
    : [];

  const enriched = versions.map(v => {
    const data = (typeof v.data === 'object' && v.data !== null ? v.data as any : {});
    const fieldCount = Array.isArray(data.fields) ? data.fields.length : 0;
    const isCurrent = v.type === 'published' && v.version === publishedVersion;
    return {
      id: v.id,
      formId: v.formId,
      version: v.version,
      type: v.type,
      summary: fieldCount ? `${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'}` : 'Empty form',
      fieldCount,
      isCurrent,
      createdBy: v.createdBy,
      createdAt: v.createdAt,
      user: creators.find(c => c.id === v.createdBy) || null,
    };
  });

  return NextResponse.json({ versions: enriched });
}

export async function restoreVersion(req: NextRequest, formId: string, versionId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);
  if (!(await canAccessForm(userId, formId))) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
  }

  const version = await prisma.formVersion.findFirst({
    where: { id: versionId, formId },
  });
  if (!version) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Version not found' } }, { status: 404 });

  const creator = await prisma.user.findUnique({ where: { id: version.createdBy }, select: { id: true, name: true, email: true } }).catch(() => null);

  const snapshot = (typeof version.data === 'object' && version.data !== null) ? version.data as any : null;
  if (!snapshot) return NextResponse.json({ error: { code: 'INVALID_DATA', message: 'This version has no restorable content' } }, { status: 400 });

  const title = typeof snapshot.title === 'string' ? snapshot.title : undefined;
  const description = typeof snapshot.description === 'string' ? snapshot.description : undefined;
  const thankYouMessage = typeof snapshot.thankYouMessage === 'string' ? snapshot.thankYouMessage : undefined;

  const current = await prisma.form.findUnique({ where: { id: formId } });
  if (!current) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const updated = await prisma.$transaction(async (tx) => {
    // Restore the snapshot's fields into the live draft (replace, not merge).
    if (Array.isArray(snapshot.fields)) {
      const existingFieldIds = await tx.formField.findMany({ where: { formId }, select: { id: true } });
      const ids = existingFieldIds.map(f => f.id);
      if (ids.length) {
        await tx.formFieldOption.deleteMany({ where: { fieldId: { in: ids } } });
        await tx.formField.deleteMany({ where: { id: { in: ids } } });
      }
      for (let i = 0; i < snapshot.fields.length; i++) {
        const f = snapshot.fields[i] || {};
        const label = sanitizeInput(typeof f.label === 'string' ? f.label : 'Untitled question', 500);
        const created = await tx.formField.create({
          data: {
            formId,
            type: isValidFieldType(f.type) ? f.type : 'text',
            label,
            required: !!f.required,
            order: typeof f.order === 'number' ? f.order : i,
            placeholder: typeof f.placeholder === 'string' ? sanitizeInput(f.placeholder, 500) : undefined,
            description: typeof f.description === 'string' ? sanitizeInput(f.description, 2000) : undefined,
            ...(f.config && typeof f.config === 'object' ? { config: normalizeFieldConfig(f.config) as any } : {}),
          },
        });
        if (Array.isArray(f.options) && f.options.length > 0) {
          await tx.formFieldOption.createMany({
            data: f.options.map((o: any, j: number) => ({
              fieldId: created.id,
              label: sanitizeInput(typeof o?.label === 'string' ? o.label : '', 500),
              value: sanitizeInput(typeof o?.value === 'string' ? o.value : (o?.label || ''), 500),
              order: j,
            })),
          });
        }
      }
    }

    // Restore title/description/settings/thank-you into the draft.
    const restored = await tx.form.update({
      where: { id: formId },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(thankYouMessage !== undefined ? { thankYouMessage } : {}),
        ...(snapshot.settings && typeof snapshot.settings === 'object'
          ? { settings: { ...((current.settings as object) || {}), ...snapshot.settings } }
          : {}),
      },
    });

    // Record the restore as a new draft revision so history stays linear.
    await tx.formVersion.create({
      data: {
        formId,
        version: version.version + 1,
        type: 'draft',
        data: buildPublishedSnapshot({ ...snapshot, ...restored }) as any,
        createdBy: userId,
      },
    });

    return restored;
  });

  createAuditEvent({
    actorId: userId,
    action: 'FORM_RESTORED',
    targetType: 'form',
    targetId: formId,
    metadata: { title: updated.title, restoredVersion: version.version },
  }).catch(() => {});

  return NextResponse.json({
    ...updated,
    restoredVersion: version.version,
    hasUnpublishedChanges: formHasUnpublishedChanges({ ...updated, publishedData: current.publishedData }),
  });
}

export async function getFormSettings(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);
  if (!(await canAccessForm(userId, formId))) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
  }
  const form = await prisma.form.findUnique({ where: { id: formId }, select: { settings: true, title: true, description: true, publicId: true, status: true, captchaEnabled: true, thankYouMessage: true } });
  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });
  const merged = withSettings(form);
  const settingsObj = (form.settings && typeof form.settings === 'object' ? form.settings : {}) as Record<string, any>;
  return NextResponse.json({
    ...merged,
    form: merged,
    notifications: {
      channels: settingsObj.notificationChannels || { email: true, slack: false, webhook: false },
      additionalEmails: Array.isArray(settingsObj.additionalEmails) ? settingsObj.additionalEmails : [],
    },
  });
}

export async function updateFormSettings(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);
  if (!(await canAccessForm(userId, formId))) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
  }
  const body: any = await req.json();
  const current = await prisma.form.findUnique({ where: { id: formId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
  if (!current) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  // Real columns the edit/settings pages send — persist to the scalar columns.
  const columnData: Record<string, any> = {};
  if (typeof body.title === 'string') {
    const t = sanitizeInput(body.title, 255);
    const xss = detectXss(t);
    if (xss) return NextResponse.json({ error: { code: 'INVALID_INPUT', message: `Invalid content in title: ${xss}` } }, { status: 400 });
    columnData.title = t;
  }
  if (typeof body.description === 'string') columnData.description = sanitizeInput(body.description, 5000);
  if (typeof body.thankYouMessage === 'string') columnData.thankYouMessage = sanitizeInput(body.thankYouMessage, 1000);
  if (typeof body.captchaEnabled === 'boolean') columnData.captchaEnabled = body.captchaEnabled;

  // Everything else is form configuration → settings JSON.
  const settings: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(key in columnData) && key !== 'fields' && !FORM_COLUMN_KEYS.has(key)) {
      // Conditional logic rules are sanitized/coerced before persisting.
      if (key === 'logicRules') {
        settings[key] = normalizeLogicRules(value);
      } else if (key === 'customCSS') {
        settings[key] = typeof value === 'string' ? sanitizeCss(value) : '';
      } else if (key === 'webhookUrl') {
        settings[key] = sanitizeWebhookUrl(value);
      } else if (key === 'notificationChannels') {
        const v = value && typeof value === 'object' ? value as Record<string, any> : {};
        settings[key] = { email: v.email !== false, slack: !!v.slack, webhook: !!v.webhook };
      } else if (key === 'webhookSecret') {
        // Secrets are generated server-side; never trust a client-supplied value.
      } else {
        settings[key] = value;
      }
    }
  }
  const mergedSettings = { ...((current.settings as object) || {}), ...settings };

  // Generate a signing secret for the webhook on first configuration.
  if (mergedSettings.webhookUrl && !mergedSettings.webhookSecret) {
    const salt = Array.from(randomBytes(16)).map((b) => b.toString(16).padStart(2, '0')).join('');
    mergedSettings.webhookSecret = createHash('sha256').update(`${mergedSettings.webhookUrl}|${Date.now()}|${salt}`).digest('hex');
  }

  // Persist fields to the relation so edits survive reloads.
  if (Array.isArray(body.fields) && formId) {
    try {
      // Delete options first (they reference fields), then fields
      const existingFieldIds = await prisma.formField.findMany({ where: { formId }, select: { id: true } });
      if (existingFieldIds.length > 0) {
        const fieldIds = existingFieldIds.map(f => f.id);
        await prisma.formFieldOption.deleteMany({ where: { fieldId: { in: fieldIds } } }).catch(() => {});
        await prisma.formField.deleteMany({ where: { id: { in: fieldIds } } }).catch(() => {});
      }
    } catch (e: any) {
      console.error('[FORM] Failed to clear existing fields:', e?.message);
    }
    for (let i = 0; i < body.fields.length; i++) {
      const f = body.fields[i];
      const label = sanitizeInput(f.label || '', 500);
      const xss = detectXss(label);
      if (xss) return NextResponse.json({ error: { code: 'INVALID_INPUT', message: `Invalid content in field label: ${xss}` } }, { status: 400 });
      const description = typeof f.description === 'string'
        ? (f.type === 'custom-html' ? sanitizeHtml(f.description, 50000) : sanitizeInput(f.description, 5000))
        : undefined;
      const created = await prisma.formField.create({
        data: {
          formId,
          type: isValidFieldType(f.type) ? f.type : 'text',
          label,
          required: !!f.required,
          order: f.order ?? i,
          placeholder: f.placeholder ? sanitizeInput(f.placeholder, 500) : undefined,
          ...(description !== undefined ? { description } : {}),
          ...(f.config && typeof f.config === 'object' ? { config: normalizeFieldConfig(f.config) as any } : {}),
        },
      });
      if (Array.isArray(f.options) && f.options.length > 0) {
        await prisma.formFieldOption.createMany({
          data: f.options.map((o: any, j: number) => ({
            fieldId: created.id,
            label: sanitizeInput(o.label || '', 500),
            value: sanitizeInput(o.value || o.label || '', 500),
            order: j,
          })),
        });
      }
    }
  }

  const updated = await prisma.form.update({
    where: { id: formId },
    data: { ...columnData, settings: mergedSettings },
  });

  // Snapshot this draft edit as a versioned row (type 'draft') so the history
  // reflects autosaves too, without touching the live published snapshot.
  const draftFull = await loadDraftSnapshot(formId);
  const draftSnapshot = draftFull ? buildPublishedSnapshot(draftFull) : undefined;
  await prisma.formVersion.create({
    data: {
      formId,
      version: (current.versions?.[0]?.version || 0) + 1,
      type: 'draft',
      data: (draftSnapshot || updated) as any,
      createdBy: userId,
    },
  });

  return NextResponse.json({
    form: {
      ...withSettings(updated),
      hasUnpublishedChanges: formHasUnpublishedChanges({ ...updated, publishedData: current.publishedData }),
    },
  });
}

export async function publicDirectory(req: NextRequest) {
  const forms = await prisma.form.findMany({
    where: { status: 'published' },
    select: { id: true, title: true, description: true, publicId: true, responseCount: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return NextResponse.json({ forms });
}

export async function exportResponses(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);
  if (!(await canAccessForm(userId, formId))) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
  }
  const [responses, form] = await Promise.all([
    prisma.response.findMany({
      where: { formId },
      include: { answers: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.form.findUnique({ where: { id: formId }, include: { fields: { orderBy: { order: 'asc' } } } }),
  ]);
  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const fields = form.fields || [];
  const headers = ['Submitted at', 'Respondent', ...fields.map((f) => `${f.label} (${f.type})`)];
  const csvEscape = (v: any) => {
    const s = v === null || v === undefined ? '' : String(Array.isArray(v) ? v.join(', ') : v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = responses.map((r) => {
    const answersObj: Record<string, any> = {};
    for (const a of r.answers || []) answersObj[a.fieldId] = a.value;
    return [
      (r.completedAt || r.createdAt || new Date()).toISOString(),
      r.respondentName || r.respondentEmail || 'Anonymous',
      ...fields.map((f) => csvEscape(answersObj[f.id])),
    ];
  });
  const csv = [headers.map(csvEscape).join(','), ...rows.map((row) => row.join(','))].join('\n');

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${form.title || 'form'}-responses.csv"`,
    },
  });
}

// ─── Built-in template catalog ───────────────────────────────────────────
// Used as a fallback when the form_templates table is empty (fresh install)
// so the Templates page is never blank. Admins can seed richer templates via
// the admin panel; built-ins are merged underneath.
interface BuiltinTemplateField {
  id: string;
  type: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];
}
interface BuiltinTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  isFeatured?: boolean;
  fields: BuiltinTemplateField[];
  theme?: Record<string, any>;
}

const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: 'builtin-feedback',
    name: 'Feedback Form',
    description: 'Collect feedback, ratings, and suggestions from your customers or team.',
    category: 'Feedback',
    icon: 'MessageSquare',
    isFeatured: true,
    fields: [
      { id: 'name', type: 'text', label: 'Your name', required: false, placeholder: 'Enter your name' },
      { id: 'rating', type: 'rating', label: 'Overall rating', required: true },
      { id: 'likes', type: 'textarea', label: 'What did you like?', required: false, placeholder: 'Tell us what worked well' },
      { id: 'improve', type: 'textarea', label: 'What can we improve?', required: false, placeholder: 'Tell us what could be better' },
    ],
  },
  {
    id: 'builtin-contact',
    name: 'Contact Form',
    description: 'Let visitors send you a message straight from your site.',
    category: 'Business',
    icon: 'Mail',
    isFeatured: true,
    fields: [
      { id: 'name', type: 'text', label: 'Full name', required: true, placeholder: 'Jane Doe' },
      { id: 'email', type: 'email', label: 'Email address', required: true, placeholder: 'jane@example.com' },
      { id: 'topic', type: 'select', label: 'Topic', required: true, options: [{ label: 'General inquiry', value: 'general' }, { label: 'Support', value: 'support' }, { label: 'Sales', value: 'sales' }, { label: 'Partnership', value: 'partnership' }] },
      { id: 'message', type: 'textarea', label: 'Message', required: true, placeholder: 'How can we help?' },
    ],
  },
  {
    id: 'builtin-event-rsvp',
    name: 'Event RSVP',
    description: 'Collect RSVPs, dietary needs, and questions for your next event.',
    category: 'Events',
    icon: 'UserPlus',
    isFeatured: true,
    fields: [
      { id: 'name', type: 'text', label: 'Your name', required: true, placeholder: 'Enter your name' },
      { id: 'email', type: 'email', label: 'Email address', required: true, placeholder: 'you@example.com' },
      { id: 'attending', type: 'radio', label: 'Will you attend?', required: true, options: [{ label: 'Yes, I will be there', value: 'yes' }, { label: 'Maybe', value: 'maybe' }, { label: 'No', value: 'no' }] },
      { id: 'guests', type: 'number', label: 'Number of guests', required: false, placeholder: '1' },
      { id: 'diet', type: 'textarea', label: 'Dietary requirements', required: false, placeholder: 'Allergies, preferences...' },
    ],
  },
  {
    id: 'builtin-survey',
    name: 'Customer Survey',
    description: 'Measure satisfaction with a clean multi-section survey.',
    category: 'Feedback',
    icon: 'BarChart3',
    fields: [
      { id: 'satisfaction', type: 'rating', label: 'How satisfied are you?', required: true },
      { id: 'recommend', type: 'radio', label: 'How likely are you to recommend us?', required: true, options: [{ label: 'Very likely', value: '5' }, { label: 'Likely', value: '4' }, { label: 'Neutral', value: '3' }, { label: 'Unlikely', value: '2' }, { label: 'Very unlikely', value: '1' }] },
      { id: 'comments', type: 'textarea', label: 'Anything else you would like to share?', required: false, placeholder: 'Your comments' },
    ],
  },
  {
    id: 'builtin-job-app',
    name: 'Job Application',
    description: 'Gather applications, experience, and links from candidates.',
    category: 'Business',
    icon: 'Briefcase',
    fields: [
      { id: 'name', type: 'text', label: 'Full name', required: true, placeholder: 'Jane Doe' },
      { id: 'email', type: 'email', label: 'Email address', required: true, placeholder: 'jane@example.com' },
      { id: 'role', type: 'text', label: 'Applying for', required: true, placeholder: 'Software Engineer' },
      { id: 'experience', type: 'select', label: 'Years of experience', required: true, options: [{ label: '0–1', value: '0-1' }, { label: '2–4', value: '2-4' }, { label: '5–8', value: '5-8' }, { label: '9+', value: '9+' }] },
      { id: 'linkedin', type: 'text', label: 'LinkedIn / portfolio URL', required: false, placeholder: 'https://' },
      { id: 'about', type: 'textarea', label: 'Why should we hire you?', required: false, placeholder: 'A few sentences about yourself' },
    ],
  },
  {
    id: 'builtin-lead-capture',
    name: 'Lead Capture',
    description: 'Capture qualified leads with a short, high-converting form.',
    category: 'Marketing',
    icon: 'UserPlus',
    fields: [
      { id: 'name', type: 'text', label: 'Name', required: true, placeholder: 'Your name' },
      { id: 'email', type: 'email', label: 'Work email', required: true, placeholder: 'you@company.com' },
      { id: 'company', type: 'text', label: 'Company', required: false, placeholder: 'Company name' },
      { id: 'interest', type: 'checkbox', label: 'What are you interested in?', required: false, options: [{ label: 'Product demo', value: 'demo' }, { label: 'Pricing', value: 'pricing' }, { label: 'Partnership', value: 'partner' }] },
    ],
  },
  {
    id: 'builtin-quiz',
    name: 'Quiz / Trivia',
    description: 'Build a fun quiz with multiple choice questions.',
    category: 'Education',
    icon: 'Star',
    fields: [
      { id: 'name', type: 'text', label: 'Your name', required: false, placeholder: 'Enter your name' },
      { id: 'q1', type: 'radio', label: 'What is the capital of France?', required: true, options: [{ label: 'Berlin', value: 'berlin' }, { label: 'Paris', value: 'paris' }, { label: 'Rome', value: 'rome' }] },
      { id: 'q2', type: 'radio', label: 'Which planet is known as the Red Planet?', required: true, options: [{ label: 'Mars', value: 'mars' }, { label: 'Venus', value: 'venus' }, { label: 'Jupiter', value: 'jupiter' }] },
      { id: 'q3', type: 'radio', label: 'What is 7 × 8?', required: true, options: [{ label: '54', value: '54' }, { label: '56', value: '56' }, { label: '58', value: '58' }] },
    ],
  },
  {
    id: 'builtin-waitlist',
    name: 'Waitlist',
    description: 'Grow anticipation and collect signups before launch.',
    category: 'Marketing',
    icon: 'Sparkles',
    fields: [
      { id: 'name', type: 'text', label: 'Full name', required: true, placeholder: 'Jane Doe' },
      { id: 'email', type: 'email', label: 'Email address', required: true, placeholder: 'jane@example.com' },
      { id: 'use', type: 'select', label: 'How will you use this?', required: false, options: [{ label: 'Personal use', value: 'personal' }, { label: 'Work / team', value: 'team' }, { label: 'Just curious', value: 'curious' }] },
    ],
  },
];

function builtinTemplate(id: string): BuiltinTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}

export async function listTemplates(req: NextRequest) {
  const dbTemplates = await (prisma as any).form_templates.findMany({ orderBy: { createdAt: 'desc' } });
  const db = (dbTemplates || []).map((t: any) => ({
    id: t.id,
    name: t.name,
    description: t.description || '',
    category: t.category || 'General',
    icon: t.icon || 'FileText',
    fields: Array.isArray(t.fields) ? t.fields : [],
    theme: t.theme || undefined,
    isFeatured: !!t.isFeatured,
    usageCount: t.usageCount || 0,
  }));
  // Fresh installs have no seeded templates — fall back to the built-in catalog.
  const templates = db.length ? db : BUILTIN_TEMPLATES;
  const categories = [...new Set(templates.map((t: any) => t.category || 'General'))].sort();
  return NextResponse.json({ templates, categories });
}

export async function createTemplate(req: NextRequest) {
  return NextResponse.json({ error: { code: 'NOT_IMPLEMENTED', message: 'Template creation not implemented' } }, { status: 501 });
}

export async function deleteTemplate(req: NextRequest, templateId: string) {
  return NextResponse.json({ error: { code: 'NOT_IMPLEMENTED', message: 'Template deletion not implemented' } }, { status: 501 });
}

export async function useTemplate(req: NextRequest, templateId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });

  // Built-in templates are always available; DB templates are created by admins.
  let template = builtinTemplate(templateId);
  if (!template) {
    const dbTemplate = await (prisma as any).form_templates.findUnique({ where: { id: templateId } });
    if (!dbTemplate) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Template not found' } }, { status: 404 });
    template = {
      id: dbTemplate.id,
      name: dbTemplate.name,
      description: dbTemplate.description || '',
      category: dbTemplate.category || 'General',
      icon: dbTemplate.icon || 'FileText',
      fields: Array.isArray(dbTemplate.fields) ? dbTemplate.fields : [],
      theme: dbTemplate.theme || undefined,
    };
    await (prisma as any).form_templates.update({
      where: { id: templateId },
      data: { usageCount: { increment: 1 } },
    }).catch(() => {});
  }

  const settings = template.theme ? { ...template.theme } : {};
  const form = await prisma.form.create({
    data: {
      title: template.name,
      description: template.description || '',
      ownerId: userId,
      publicId: generatePublicId(),
      status: 'draft',
      settings: Object.keys(settings).length ? settings : undefined,
    },
  });

  // Seed the template's fields so the editor opens with real questions.
  if (template.fields && template.fields.length > 0) {
    for (let i = 0; i < template.fields.length; i++) {
      const f = template.fields[i];
      const created = await prisma.formField.create({
        data: {
          formId: form.id,
          type: sanitizeInput(String(f.type || 'text'), 50),
          label: sanitizeInput(String(f.label || 'Question'), 500),
          required: !!f.required,
          order: i,
          placeholder: f.placeholder ? sanitizeInput(String(f.placeholder), 500) : undefined,
        },
      });
      if (Array.isArray(f.options) && f.options.length > 0) {
        await prisma.formFieldOption.createMany({
          data: f.options.map((o: any, j: number) => ({
            fieldId: created.id,
            label: sanitizeInput(String(o.label || o.value || ''), 500),
            value: sanitizeInput(String(o.value || o.label || ''), 500),
            order: j,
          })),
        });
      }
    }
  }

  return NextResponse.json({ id: form.id }, { status: 201 });
}

export async function getFormOverview(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);
  if (!(await canAccessForm(userId, formId))) {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this form' } }, { status: 403 });
  }
  const [form, recentResponses, allResponses, totalResponses] = await Promise.all([
    prisma.form.findUnique({ where: { id: formId }, include: { fields: { include: { options: true }, orderBy: { order: 'asc' } } } }),
    prisma.response.findMany({
      where: { formId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { answers: true },
    }),
    prisma.response.findMany({
      where: { formId, createdAt: { gte: new Date(Date.now() - 14 * 86400000) } },
      select: { createdAt: true, duration: true },
    }),
    prisma.response.count({ where: { formId } }),
  ]);
  if (!form) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Form not found' } }, { status: 404 });

  const settings = (form.settings as Record<string, any>) || {};
  const durations = allResponses.map((r) => r.duration).filter((d): d is number => typeof d === 'number');
  const avgTimeSeconds = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const viewCount = form.viewCount || 0;
  const completionRate = viewCount > 0 ? Math.min(100, Math.round((totalResponses / viewCount) * 100)) : 0;

  const days = 14;
  const timeline: { date: string; views: number; responses: number }[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    timeline.push({ date: d.toISOString().slice(0, 10), views: 0, responses: 0 });
  }
  const counts = new Map<string, number>();
  for (const r of allResponses) {
    const key = (r.createdAt || new Date()).toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const point of timeline) {
    point.responses = counts.get(point.date) || 0;
  }

  // Distribute total views across the timeline so a fresh form never renders
  // an all-zero chart. When there's real response activity, scale views
  // proportionally per day (largest-remainder so nothing is lost); otherwise
  // spread views across the most recent days, biased toward today.
  if (allResponses.length > 0) {
    const shares = timeline.map(p => (viewCount * p.responses) / allResponses.length);
    const floors = shares.map(Math.floor);
    let assigned = floors.reduce((a, b) => a + b, 0);
    const order = timeline
      .map((p, i) => ({ i, frac: shares[i] - floors[i] }))
      .sort((a, b) => b.frac - a.frac || b.i - a.i);
    let k = 0;
    while (assigned < viewCount && k < order.length) {
      floors[order[k].i] += 1;
      assigned += 1;
      k += 1;
    }
    timeline.forEach((p, i) => { p.views = floors[i]; });
  } else if (viewCount > 0) {
    const recent = Math.min(days, viewCount);
    timeline.forEach((p, i) => {
      p.views = timeline.length - 1 - i < recent ? 1 : 0;
    });
    timeline[timeline.length - 1].views += viewCount - recent;
  }

  return NextResponse.json({
    id: form.id,
    title: form.title,
    status: form.status,
    publicId: form.publicId,
    source: settings.source === 'admin' ? 'admin' : 'user',
    responseCount: totalResponses,
    viewCount,
    completionRate,
    avgTimeSeconds,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
    publishedAt: form.publishedAt || undefined,
    recentResponses: recentResponses.map((r) => ({
      id: r.id,
      respondent: r.respondentName || r.respondentEmail || undefined,
      submittedAt: (r.completedAt || r.createdAt || new Date()).toISOString(),
      duration: r.duration,
    })),
    fields: (form.fields || []).map((f) => ({ id: f.id, label: f.label, type: f.type })),
    timeline,
  });
}

export async function formPagesListHandler(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);
  const pages = await prisma.formPage.findMany({ where: { formId }, orderBy: { order: 'asc' } });
  return NextResponse.json({ pages });
}

export async function formPagesCreateHandler(req: NextRequest, formId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  formId = await resolveFormId(formId);
  const body: any = await req.json();
  const page = await prisma.formPage.create({
    data: { formId, title: body.title || 'Page', order: body.order || 0 },
  });
  return NextResponse.json(page, { status: 201 });
}

export async function responseAnswersListHandler(req: NextRequest, responseId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  const answers = await prisma.responseAnswer.findMany({
    where: { responseId },
    include: { field: true },
  });
  return NextResponse.json({ answers });
}

export async function responseNotesListHandler(req: NextRequest, responseId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  const notes = await prisma.responseNote.findMany({
    where: { responseId },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ notes });
}

export async function responseNotesCreateHandler(req: NextRequest, responseId: string) {
  const userId = await getUserId(req);
  if (!userId) return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
  const body: any = await req.json();
  const note = await prisma.responseNote.create({
    data: { responseId, userId, content: sanitizeInput(body.content || '', 20000) },
  });
  return NextResponse.json(note, { status: 201 });
}

export async function getFormSettingsHandler(req: NextRequest) {
  const formId = req.nextUrl.searchParams.get("formId") || ""; return getFormSettings(req, formId);
}

export async function updateFormSettingsHandler(req: NextRequest) {
  const formId = req.nextUrl.searchParams.get("formId") || ""; return updateFormSettings(req, formId);
}
