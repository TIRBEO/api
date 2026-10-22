import { prisma } from '@/infrastructure/db/prisma';
import type { Prisma } from '@prisma/client';
import { hasConsent } from '@/features/users/consent';
import { sendToUserWs } from '@/infrastructure/realtime/ws-deliver';
import { currentRequestOrigin } from '@/infrastructure/observability/requestContext';
import { NO_ORIGIN, type ChangeOrigin } from '@/shared/changeOrigin';
import { eventRowRef, refCodeCandidates } from '@/features/users/refcode';

type Severity = 'info' | 'warning' | 'error' | 'critical';

/** Namespaces that say who did it, not what happened. A row already filed
    under `profile` does not need to read "Profile company name updated". */
const NAMESPACE = new Set([
  'profile', 'user', 'account', 'settings', 'security', 'auth', 'data', 'consent', 'content', 'admin',
]);

/** Words a split would otherwise leave mangled. */
const WORD = new Map<string, string>([
  ['2fa', 'two-factor'], ['mfa', 'two-factor'], ['totp', 'authenticator'], ['otp', 'code'],
  ['ip', 'IP'], ['id', 'ID'], ['url', 'link'], ['csrf', 'security'], ['qr', 'QR'], ['api', 'API'],
]);

/**
 * "profile.companyName.updated" -> "Company name updated".
 *
 * The ledger's `kind` is a machine key and it stays that way; the `title`
 * beside it is what a person reads on their own activity page, so it must
 * never be the key. Callers may still pass their own title, and this is only
 * the fallback — including for the rows written before it existed, which the
 * read side runs through the same function.
 */
export function humanTitle(action: string): string {
  const segments = action.split('.').filter(Boolean);
  if (segments.length > 1 && NAMESPACE.has(segments[0].toLowerCase())) {
    const rest = segments.slice(1);
    // Keep the namespace if dropping it would leave nothing to stand as the subject.
    if (rest.join('.').split(/[._]/).filter(Boolean).length > 1) segments.splice(0, 1);
  }
  const words = segments
    .flatMap((segment) => segment.split('_'))
    .flatMap((word) => word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' '))
    .map((word) => word.toLowerCase())
    .filter(Boolean)
    .map((word) => WORD.get(word) ?? word);
  if (!words.length) return action;
  const phrase = words.join(' ');
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

interface AuditInput {
  actorId?: string;
  action: string;
  /** What the person reads. Defaults to the action, made readable. */
  title?: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  severity?: Severity;
  /** Where the change arrived from. Left out, the row honestly says nothing
      happened somewhere rather than guessing a place. */
  ip?: string | null;
  userAgent?: string | null;
  location?: string | null;
  /** Latitude/longitude the edge resolved the address to, when it resolved one. */
  coords?: [number, number] | null;
  /**
   * The whole origin, for a writer that has the request in hand. Routes behind
   * the dispatcher get the request's origin from the async context; a standalone
   * route is its own door and names it here instead.
   */
  origin?: ChangeOrigin;
}

export async function createAuditEvent(input: AuditInput) {
  // activity_events.user_id has a NOT-NULL FK to users(id) — an event with no
  // real actor can't be persisted, so there is nothing attributable to record.
  if (!input.actorId) return;

  /* A writer that names no origin is not saying "this happened nowhere" — it is
     a route three calls from the handler that holds the request. Take what that
     request came from; a background job has none, and gets nothing. */
  const partial = input.ip !== undefined || input.userAgent !== undefined
    || input.location !== undefined || input.coords !== undefined;
  const named = input.origin ?? (partial ? {
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    location: input.location ?? null,
    coords: input.coords ?? null,
  } : null);
  const src = named ?? currentRequestOrigin() ?? NO_ORIGIN;
  const { ip, userAgent, location, coords } = src;

  const data = {
    userId: input.actorId,
    kind: input.action,
    title: input.title || humanTitle(input.action),
    detail: input.targetType ? `${input.targetType}:${input.targetId || ''}` : null,
    metadata: {
      ...(input.metadata || {}),
      targetType: input.targetType || null,
      targetId: input.targetId || null,
      ...(location ? { location } : {}),
      ...(coords ? { coords } : {}),
    } as Prisma.InputJsonValue,
    severity: input.severity || 'info',
    ipAddress: ip ?? null,
    userAgent: userAgent ?? null,
  };

  // Server-side consent check: skip audit logging if user opted out of analytics
  {
    const analyticsAllowed = await hasConsent(input.actorId, 'analytics');
    if (!analyticsAllowed) {
      // Still create the audit event (it's a security record), but skip WebSocket broadcast
      // The event is stored for compliance but not surfaced in real-time
      await prisma.activityEvent.create({ data });
      return;
    }
  }

  const event = await prisma.activityEvent.create({ data });

  // Send real-time WebSocket notification to the user (only if analytics consented)
  if (input.actorId) {
    try {
      sendToUserWs(input.actorId, {
        type: 'activity',
        event: {
          id: event.id,
          action: event.kind,
          metadata: event.metadata,
          severity: event.severity,
          createdAt: event.createdAt.toISOString(),
        },
      });
    } catch {}
  }
}

export async function listAuditEvents(options: {
  limit?: number;
  offset?: number;
  id?: string;
  action?: string;
  actorId?: string;
  targetType?: string;
  severity?: string;
  from?: string;
  to?: string;
}) {
  const where: Record<string, unknown> = {};
  if (options.id) {
    /* The "Event ID" box accepts both shapes staff actually have: the row's
       own uuid, and the short reference code (xxxx-xxxx-xxxx) shown to users
       and quoted in support emails — which lives in metadata.refCode (stamped
       at write) or, on legacy rows, derives from the id. Non-uuid input is
       tried against every stored refCode candidate shape. */
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.id);
    if (isUuid) {
      where.id = options.id;
    } else {
      const candidates = refCodeCandidates(options.id);
      const idPrefix = options.id.toLowerCase().replace(/[^0-9a-f]/g, '');
      const or: Record<string, unknown>[] = candidates.map((c) => ({ metadata: { path: ['refCode'], equals: c } }));
      // A code derived from a row id (leading hex of the uuid) matches a
      // uuid prefix — as deep as the typed quote carries digits.
      if (idPrefix.length >= 16) {
        or.push({ id: { startsWith: `${idPrefix.slice(0, 8)}-${idPrefix.slice(8, 12)}-${idPrefix.slice(12, 16)}-` } });
      } else if (idPrefix.length >= 12) {
        or.push({ id: { startsWith: `${idPrefix.slice(0, 8)}-${idPrefix.slice(8, 12)}-` } });
      }
      where.OR = or;
    }
  }
  if (options.action) where.kind = { contains: options.action };
  if (options.actorId) where.userId = options.actorId;
  if (options.severity) where.severity = options.severity;
  if (options.from || options.to) {
    const createdAt: Record<string, Date> = {};
    if (options.from) createdAt.gte = new Date(options.from);
    if (options.to) createdAt.lte = new Date(options.to);
    where.createdAt = createdAt;
  }

  const limit = Math.min(options.limit || 50, 200);
  const offset = options.offset || 0;

  const [events, total] = await Promise.all([
    prisma.activityEvent.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: { id: true, userId: true, kind: true, title: true, detail: true, metadata: true, severity: true, createdAt: true },
    }),
    prisma.activityEvent.count({ where: where as any }),
  ]);

  /* The trail names an actor by id, which is the right thing to store and the
     wrong thing to show: a console row that reads "1005d8d1-523f-…" answers
     "who" for nobody. One batched read turns the page's distinct ids into
     people; a null means the account is gone, and the id stays on the row so
     the link still reaches the record. */
  const actorIds = [...new Set(events.map((e: any) => e.userId).filter(Boolean))] as string[];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, email: true, username: true, profile: { select: { name: true } } } })
    : [];
  const actorById = new Map(actors.map((a: any) => [
    a.id, { email: a.email, username: a.username, name: a.profile?.name ?? null }]));

  return {
    total, limit, offset,
    events: events.map((e: any) => ({
      ...e,
      ref: eventRowRef(e),
      action: e.kind,
      actorId: e.userId,
      actor: e.userId ? actorById.get(e.userId) ?? null : null,
    })),
  };
}
