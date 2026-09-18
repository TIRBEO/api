/**
 * Email Brain — Deterministic Email Decision Engine.
 *
 * For every event: registry → user preferences → dedup → rate limits →
 * IMMEDIATE / DIGEST / DIGEST-ITEM / SUPPRESS. No AI in this path. Docs:
 * docs/email-brain/01-architecture.md §3
 */
import { prisma } from '@/infrastructure/db/prisma';
import { getEventDef } from '@/features/email-brain/registry';

export type EmitOutcome =
  | 'queued'
  | 'digest'
  | 'digest_queued'
  | 'duplicate'
  | 'suppressed'
  | 'rate_limited'
  | 'unknown_event'
  | 'disabled';

export interface EmitInput {
  eventKey: string;
  userId?: string;
  toEmail: string;
  /** Idempotency identity, e.g. `password-reset:user_123:request_456`. */
  dedupeKey?: string;
  /** Non-sensitive variable values for content rendering. */
  vars?: Record<string, string>;
  /** Extra digest item fields when routed to digest. */
  digest?: { title: string; body?: string; entityGroup?: string; importance?: number };
}

/** Per user+event rate limit: max N emails per window (mandatory events exempt). */
const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  default: { max: 10, windowMs: 60 * 60 * 1000 }, // 10/hour per user+event
  'activity.mention': { max: 1, windowMs: 24 * 60 * 60 * 1000 },
};

function dedupeFullKey(eventKey: string, dedupeKey: string): string {
  return `${eventKey}:${dedupeKey}`;
}

async function getUserFrequency(userId: string, eventKey: string): Promise<string> {
  try {
    const pref = await prisma.email_preferences.findUnique({
      where: { userId_eventKey: { userId, eventKey } },
      select: { frequency: true },
    });
    return pref?.frequency || 'default';
  } catch {
    return 'default';
  }
}

async function checkRateLimit(eventKey: string, userId: string, mandatory: boolean): Promise<boolean> {
  if (mandatory || !userId) return true;
  const limit = RATE_LIMITS[eventKey] || RATE_LIMITS.default;
  const since = new Date(Date.now() - limit.windowMs);
  const count = await prisma.email_jobs.count({
    where: {
      userId,
      eventKey,
      createdAt: { gte: since },
      status: { in: ['queued', 'processing', 'sent'] },
    },
  });
  return count < limit.max;
}

export async function emitEmailEvent(input: EmitInput): Promise<{ outcome: EmitOutcome; jobId?: string }> {
  const def = getEventDef(input.eventKey);
  if (!def) return { outcome: 'unknown_event' };
  if (!def.enabled) return { outcome: 'disabled' };

  // 1. Preferences check BEFORE creating anything (mandatory events skip).
  const frequency = input.userId ? await getUserFrequency(input.userId, def.eventKey) : 'default';
  if (!def.mandatory && frequency === 'never') {
    await recordSuppression(input, 'preference');
    return { outcome: 'suppressed' };
  }

  // 2. Rate limit (mandatory/security exempt).
  if (input.userId && !(await checkRateLimit(input.eventKey, input.userId, def.mandatory))) {
    await recordSuppression(input, 'rate_limit');
    return { outcome: 'rate_limited' };
  }

  // 3. Route: immediate vs digest (user frequency can downgrade immediate→digest
  //    but never upgrade digest→immediate, and never applies to mandatory events).
  const effectiveDelivery =
    !def.mandatory && ['daily', 'weekly', 'monthly'].includes(frequency)
      ? 'digest'
      : def.delivery;

  // 4. Dedup — the unique index on dedupeKey is the source of truth. We create
  //    the job (or digest item) inside a try and treat P2002 as a duplicate.
  const fullKey = input.dedupeKey ? dedupeFullKey(def.eventKey, input.dedupeKey) : null;

  if (effectiveDelivery === 'digest') {
    if (!input.userId) return { outcome: 'suppressed' };
    try {
      await prisma.email_digest_items.create({
        data: {
          userId: input.userId,
          category: def.category,
          entityGroup: input.digest?.entityGroup || def.eventKey,
          title: input.digest?.title || def.description,
          body: input.digest?.body,
          importance: input.digest?.importance ?? 0,
          dedupeKey: fullKey || `${def.eventKey}:${input.toEmail}:${Date.now()}`,
          payload: (input.vars || {}) as any,
        },
      });
      return { outcome: 'digest' };
    } catch (e: any) {
      if (e?.code === 'P2002') return { outcome: 'duplicate' };
      throw e;
    }
  }

  try {
    const job = await prisma.email_jobs.create({
      data: {
        dedupeKey: fullKey,
        eventKey: def.eventKey,
        userId: input.userId ?? null,
        toEmail: input.toEmail,
        category: def.category,
        priority: def.mandatory ? 'high' : 'normal',
        status: 'queued',
        payload: (input.vars || {}) as any,
      },
    });
    return { outcome: 'queued', jobId: job.id };
  } catch (e: any) {
    if (e?.code === 'P2002') return { outcome: 'duplicate' };
    throw e;
  }
}

async function recordSuppression(input: EmitInput, reason: string): Promise<void> {
  try {
    await prisma.email_suppressions.create({
      data: {
        userId: input.userId ?? null,
        toEmail: input.toEmail,
        eventKey: input.eventKey,
        reason,
        dedupeKey: input.dedupeKey ? dedupeFullKey(input.eventKey, input.dedupeKey) : null,
      },
    });
  } catch {
    /* best-effort audit row */
  }
}
