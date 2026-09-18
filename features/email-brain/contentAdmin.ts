/**
 * Email Brain — Content admin handlers (requireAdmin-guarded).
 * Definitions, versions, AI generation, activation lifecycle, test sends.
 * AI actions never auto-activate; activation is an explicit admin action.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requireAdmin } from '@/features/auth/http-guards';
import { z } from 'zod';
import { generateContent, ContentSchema, type EmailContent } from '@/features/email-brain/ai';
import { renderEmail } from '@/features/email-brain/render';
import { sendEmail } from '@/features/email/email';
import { getEventDef } from '@/features/email-brain/registry';

const zodCreateDef = z.object({
  eventKey: z.string().min(1),
  name: z.string().min(1).max(120),
  content: ContentSchema.optional(),
});

const OK = (data: unknown, status = 200) => NextResponse.json(data, { status });
const BAD = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** AI action rate limit per admin: 30 actions / 10 min. */
const aiLimiter = new Map<string, { count: number; resetAt: number }>();
function checkAiRateLimit(adminId: string, max = 30, windowMs = 10 * 60_000): boolean {
  const now = Date.now();
  const entry = aiLimiter.get(adminId);
  if (!entry || now > entry.resetAt) {
    aiLimiter.set(adminId, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

// ── Definitions ─────────────────────────────────────────────────────────────

export async function emailBrainDefinitionsHandler(request: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const url = new URL(request.url);
  const eventKey = url.searchParams.get('eventKey');

  if (request.method === 'POST') {
    // Create definition (optionally with an initial version from AI output).
    const body = await request.json().catch(() => null);
    const parsed = zodCreateDef.safeParse(body);
    if (!parsed.success) return BAD('Invalid input');
    const def = getEventDef(parsed.data.eventKey);
    if (!def) return BAD('Unknown event');

    const definition = await prisma.email_definitions.create({
      data: {
        eventKey: parsed.data.eventKey,
        name: parsed.data.name,
        createdBy: session.userId,
        versions: parsed.data.content
          ? {
              create: {
                version: 1,
                subject: parsed.data.content.subject,
                blocks: parsed.data.content.blocks as any,
                origin: 'ai',
                createdBy: session.userId,
              },
            }
          : undefined,
      },
      include: { versions: true },
    });
    return OK({ definition }, 201);
  }

  const defs = await prisma.email_definitions.findMany({
    where: eventKey ? { eventKey } : undefined,
    include: { versions: { orderBy: [{ language: 'asc' }, { version: 'desc' }], take: 10 } },
    orderBy: { updatedAt: 'desc' },
  });
  return OK({ definitions: defs });
}

// ── Definition lifecycle (activate / archive / rollback) ────────────────────

export async function emailBrainDefinitionActionHandler(
  request: NextRequest,
  definitionId: string,
): Promise<NextResponse> {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const definition = await prisma.email_definitions.findUnique({
    where: { id: definitionId },
    include: { versions: { orderBy: { version: 'desc' } } },
  });
  if (!definition) return BAD('Definition not found', 404);

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    const action = (body as any).action;

    if (action === 'activate') {
      const versionId = (body as any).versionId as string | undefined;
      const version = versionId
        ? definition.versions.find((v) => v.id === versionId)
        : definition.versions.find((v) => v.status === 'approved');
      if (!version) return BAD('No approved version to activate');
      await prisma.$transaction([
        prisma.email_definitions.update({
          where: { id: definition.id },
          data: { status: 'active', activeVersionId: version.id },
        }),
        prisma.email_versions.update({
          where: { id: version.id },
          data: { status: 'active' },
        }),
      ]);
      return OK({ activated: true, versionId: version.id });
    }

    if (action === 'approve') {
      const versionId = (body as any).versionId as string;
      const version = definition.versions.find((v) => v.id === versionId);
      if (!version) return BAD('Version not found', 404);
      await prisma.email_versions.update({
        where: { id: version.id },
        data: { status: 'approved' },
      });
      return OK({ approved: true, versionId: version.id });
    }

    if (action === 'archive') {
      await prisma.email_definitions.update({
        where: { id: definition.id },
        data: { status: 'archived', activeVersionId: null },
      });
      return OK({ archived: true });
    }

    return BAD('Unknown action');
  }

  return OK({ definition });
}

// ── Versions ────────────────────────────────────────────────────────────────

export async function emailBrainVersionsHandler(
  request: NextRequest,
  definitionId: string,
): Promise<NextResponse> {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  if (request.method !== 'POST') return BAD('Method not allowed', 405);

  const body = await request.json().catch(() => null);
  const parsed = ContentSchema.safeParse(body);
  if (!parsed.success) return BAD('Invalid content');

  const definition = await prisma.email_definitions.findUnique({
    where: { id: definitionId },
    include: { _count: { select: { versions: true } } },
  });
  if (!definition) return BAD('Definition not found', 404);

  const version = await prisma.email_versions.create({
    data: {
      definitionId,
      version: definition._count.versions + 1,
      subject: parsed.data.subject,
      blocks: parsed.data.blocks as any,
      origin: 'manual',
      createdBy: session.userId,
    },
  });
  return OK({ version }, 201);
}

// ── AI actions (generate / rewrite / translate) ─────────────────────────────

export async function emailBrainAiHandler(request: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  if (!checkAiRateLimit(session.userId)) {
    return BAD('AI rate limit exceeded — try again later', 429);
  }

  const body = await request.json().catch(() => null);
  const task = (body as any)?.task;
  const eventKey = (body as any)?.eventKey;
  if (!eventKey) return BAD('eventKey required');

  let current: EmailContent | undefined;
  if ((body as any)?.current) {
    const parsed = ContentSchema.safeParse((body as any).current);
    if (!parsed.success) return BAD('Invalid current content');
    current = parsed.data;
  }

  const result = await generateContent({
    task,
    eventKey,
    tone: (body as any)?.tone,
    instruction: (body as any)?.instruction,
    current,
    targetLang: (body as any)?.targetLang,
    requestedBy: session.userId,
  });
  if (result.error || !result.content) return BAD(result.error || 'AI generation failed', 502);
  return OK({ content: result.content, cached: result.cached });
}

// ── Preview + test send ─────────────────────────────────────────────────────

export async function emailBrainPreviewHandler(request: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json().catch(() => null);
  const parsed = ContentSchema.safeParse(body);
  if (!parsed.success) return BAD('Invalid content');

  const { html, text } = renderEmail(parsed.data as EmailContent, {
    'user.name': 'Alex',
    dashboardUrl: process.env.NEXT_PUBLIC_DASHBOARD_URL || 'https://dashboard.tirbeo.app',
  }, { footerNote: 'Preview' });
  return OK({ html, text });
}

export async function emailBrainTestHandler(request: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json().catch(() => null);
  const to = (body as any)?.to;
  const content = ContentSchema.safeParse((body as any)?.content);
  if (!to || !content.success) return BAD('to and content required');

  const result = await sendEmail(to, content.data.subject, renderEmail(content.data as EmailContent, {
    'user.name': 'Alex',
    dashboardUrl: process.env.NEXT_PUBLIC_DASHBOARD_URL || 'https://dashboard.tirbeo.app',
  }, { footerNote: 'Test email' }).html, {
    templateName: 'brain:test',
  });
  return OK({ success: result.success, error: result.error ?? null });
}
