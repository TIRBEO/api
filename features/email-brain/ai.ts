/**
 * Email Brain — AI Content Engine (generation-time ONLY).
 *
 * AI never runs on the send path. It creates/edits/translates *content versions*
 * that admins approve and activate. Cost controls implemented here:
 *   1. Fingerprint cache — identical generation requests reuse stored results.
 *   2. Structured output — zod-validated JSON blocks, no free-form HTML.
 *   3. Minimal context — brand block + event purpose + variable schema only.
 *   4. Model routing — cheap model for rewrites/subjects, strong for full drafts.
 * Every call is recorded in `ai_generations` for the usage/cost dashboard.
 */
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '@/infrastructure/db/prisma';
import { getEventDef } from '@/features/email-brain/registry';

// ── Model routing (OpenRouter; both models are in the existing allowlist) ──
const MODEL_CHEAP = process.env.EMAIL_AI_MODEL_CHEAP || 'mistralai/mistral-small-3.1-24b-instruct:free';
const MODEL_STRONG = process.env.EMAIL_AI_MODEL_STRONG || 'google/gemini-2.0-flash-exp:free';

export type AiTask = 'generate' | 'rewrite' | 'translate' | 'subject' | 'digest_summary';

interface OpenRouterUsage { prompt_tokens?: number; completion_tokens?: number }

// ── Structured output schema (blocks, never raw HTML) ─────────────────────
const BlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: z.string().max(200) }),
  z.object({ type: z.literal('paragraph'), text: z.string().max(2000) }),
  z.object({ type: z.literal('button'), label: z.string().max(80), url: z.string().max(500) }),
  z.object({ type: z.literal('alert'), tone: z.enum(['info', 'warning', 'error', 'success']), text: z.string().max(1000) }),
  z.object({ type: z.literal('divider') }),
  z.object({ type: z.literal('list'), items: z.array(z.string().max(300)).max(10) }),
]);
export const ContentSchema = z.object({
  subject: z.string().min(1).max(200),
  blocks: z.array(BlockSchema).min(1).max(20),
});
export type EmailContent = z.infer<typeof ContentSchema>;
export type EmailBlock = EmailContent['blocks'][number];

// ── Compact reusable context (never application state / user records) ─────
function brandContext(): string {
  return [
    'Brand: Tirbeo',
    'Tone: professional, simple, trustworthy',
    'Email rules:',
    '- Do not exaggerate or invent facts.',
    '- Use ONLY the provided variables, written exactly like {{user.name}}.',
    '- Do not invent variables or URLs.',
    '- Do not include security values, tokens, or links you were not given.',
    '- Keep it short. Prefer 3-6 blocks.',
  ].join('\n');
}

function eventContext(eventKey: string): string {
  const def = getEventDef(eventKey);
  if (!def) return `Event: ${eventKey}`;
  return [
    `Event: ${def.eventKey}`,
    `Purpose: ${def.description}`,
    `Category: ${def.category}`,
    `Available variables: ${def.variables.join(', ') || '(none)'}`,
  ].join('\n');
}

/** sha256 fingerprint of everything that determines the result. */
function fingerprint(parts: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// ── OpenRouter call (raw fetch, JSON mode, one retry) ─────────────────────
async function callModel(
  model: string,
  system: string,
  user: string,
): Promise<{ content: string; usage?: OpenRouterUsage }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not configured');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: 1200,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI provider error ${res.status}: ${err.slice(0, 300)}`);
  }
  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('Empty AI response');
  return { content, usage: data?.usage };
}

/** Rough cost estimate — free models cost 0; keep hook for paid models. */
function estimateCost(model: string, usage?: OpenRouterUsage): number {
  const free = model.endsWith(':free');
  if (free || !usage) return 0;
  // Placeholder per-token rates; adjust when paid models are enabled.
  return ((usage.prompt_tokens || 0) * 0.15 + (usage.completion_tokens || 0) * 0.6) / 1_000_000;
}

async function recordGeneration(row: {
  task: AiTask; fingerprint: string; eventKey?: string; model: string;
  tone?: string; instruction?: string; targetLang?: string;
  usage?: OpenRouterUsage; status: 'succeeded' | 'failed'; error?: string;
  cached: boolean; requestedBy?: string; result?: EmailContent;
}): Promise<void> {
  try {
    await prisma.ai_generations.create({
      data: {
        task: row.task,
        fingerprint: row.fingerprint,
        eventKey: row.eventKey ?? null,
        model: row.model,
        tone: row.tone ?? null,
        instruction: row.instruction ?? null,
        targetLang: row.targetLang ?? null,
        inputTokens: row.usage?.prompt_tokens ?? null,
        outputTokens: row.usage?.completion_tokens ?? null,
        costEstimate: estimateCost(row.model, row.usage),
        status: row.status,
        error: row.error?.slice(0, 500) ?? null,
        cached: row.cached,
        requestedBy: row.requestedBy ?? null,
        resultSubject: row.result?.subject ?? null,
        resultBlocks: (row.result?.blocks ?? undefined) as any,
      },
    });
  } catch { /* ledger is best-effort */ }
}

async function findCached(fp: string): Promise<EmailContent | null> {
  const hit = await prisma.ai_generations.findFirst({
    where: { fingerprint: fp, status: 'succeeded', resultSubject: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  if (!hit) return null;
  const parsed = ContentSchema.safeParse({ subject: hit.resultSubject, blocks: hit.resultBlocks ?? [] });
  if (!parsed.success) return null;
  // Reuse is free — bump the counter so cache value stays visible.
  prisma.ai_generations.update({ where: { id: hit.id }, data: { usedCount: { increment: 1 } } }).catch(() => {});
  return parsed.data;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface GenerateInput {
  task: AiTask;
  eventKey: string;
  tone?: string;
  instruction?: string;
  current?: EmailContent;   // for rewrite tasks
  targetLang?: string;      // for translate tasks
  requestedBy?: string;
}

export async function generateContent(
  input: GenerateInput,
): Promise<{ content?: EmailContent; cached: boolean; generationId?: string; error?: string }> {
  const def = getEventDef(input.eventKey);
  if (!def) return { cached: false, error: `Unknown event: ${input.eventKey}` };

  const model = input.task === 'generate' ? MODEL_STRONG : MODEL_CHEAP;
  const fp = fingerprint({
    task: input.task, eventKey: input.eventKey, tone: input.tone || 'professional',
    instruction: input.instruction || '', lang: input.targetLang || 'en',
    current: input.current || null, rulesVersion: 1,
  });

  // Cache first — equivalent requests never re-call the model.
  const cached = await findCached(fp);
  if (cached) {
    await recordGeneration({
      task: input.task, fingerprint: fp, eventKey: input.eventKey, model,
      tone: input.tone, instruction: input.instruction, targetLang: input.targetLang,
      cached: true, status: 'succeeded', result: cached, requestedBy: input.requestedBy,
    });
    return { content: cached, cached: true };
  }

  const system = [
    'You write transactional product email content for Tirbeo.',
    brandContext(),
    'Respond with JSON only: {"subject": string, "blocks": Block[]}.',
    'Block types: heading{text}, paragraph{text}, button{label,url}, alert{tone:info|warning|error|success,text}, divider{}, list{items}.',
    'In text and urls use variable placeholders exactly like {{user.name}}.',
  ].join('\n');

  let user: string;
  if (input.task === 'generate') {
    user = `${eventContext(input.eventKey)}\nTone: ${input.tone || 'professional'}\nWrite the complete email.`;
  } else if (input.task === 'rewrite' && input.current) {
    user = `${eventContext(input.eventKey)}\nCurrent content:\n${JSON.stringify(input.current)}\nInstruction: ${input.instruction || 'Improve this email.'}\nKeep all variables intact. Return the full updated content.`;
  } else if (input.task === 'translate' && input.current) {
    user = `${eventContext(input.eventKey)}\nTranslate this email to ${input.targetLang || 'en'}:\n${JSON.stringify(input.current)}\nKeep every {{variable}} untouched. Return the translated content.`;
  } else if (input.task === 'subject' && input.current) {
    user = `${eventContext(input.eventKey)}\nRewrite only the subject line. Tone: ${input.tone || 'professional'}. Current: ${input.current.subject}\nReturn JSON {"subject": string, "blocks": []}.`;
  } else {
    return { cached: false, error: 'Invalid task/input combination' };
  }

  try {
    const { content, usage } = await callModel(model, system, user);
    const parsed = ContentSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      await recordGeneration({
        task: input.task, fingerprint: fp, eventKey: input.eventKey, model,
        tone: input.tone, instruction: input.instruction, targetLang: input.targetLang,
        status: 'failed', error: 'Schema validation failed', cached: false,
        requestedBy: input.requestedBy,
      });
      return { cached: false, error: 'AI returned invalid content structure' };
    }
    await recordGeneration({
      task: input.task, fingerprint: fp, eventKey: input.eventKey, model,
      tone: input.tone, instruction: input.instruction, targetLang: input.targetLang,
      usage, status: 'succeeded', cached: false, result: parsed.data,
      requestedBy: input.requestedBy,
    });
    return { content: parsed.data, cached: false };
  } catch (e: any) {
    await recordGeneration({
      task: input.task, fingerprint: fp, eventKey: input.eventKey, model,
      tone: input.tone, instruction: input.instruction, targetLang: input.targetLang,
      status: 'failed', error: e?.message || 'AI request failed', cached: false,
      requestedBy: input.requestedBy,
    });
    return { cached: false, error: e?.message || 'AI request failed' };
  }
}
