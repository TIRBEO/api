import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession, requireRole } from '@/features/auth/http-guards';
import { humanTitle } from '@/features/security/audit';
import { getClientIp, getUserAgent } from '@/features/security/security';

/* ═══════════════════════════════════════════════════════════════════
   Feedback — written to the ledger, not into a void.

   `POST /api/feedback` used to answer `{ ok: 'Feedback received' }` and
   persist nothing: the person was told their words landed somewhere, and they
   did not. They now land in `activity_events`, the audit table every other
   user-visible statement in this API is checked against — same row shape the
   admin event list already reads, so "what did people tell us about this
   page?" is a query, not a hope.

   Bounds, because the endpoint is public (`proxy.ts` lists it alongside the
   waitlist): every field is length-capped, the vote is a whitelist, the
   metadata bag must be a plain JSON object that fits 4 KB, and a payload with
   nothing sayable in it is refused rather than stored. A public sink with no
   bounds is a storage-DoS with a friendly name.

   Anonymous by design: a "was this helpful?" tap happens on a page someone may
   not have signed into. When a session cookie IS present the row is attributed
   to the account; the client never gets to name the user it claims to be.
   ═══════════════════════════════════════════════════════════════════ */

const LIMITS = {
  kind: 40,
  source: 40,
  page: 300,
  articleId: 120,
  comment: 2000,
  title: 140,
  detail: 500,
  metadataBytes: 4 * 1024,
  maxFields: 24,
} as const;

/** A vote is a small enum, not free text — anything else is dropped, not stored. */
const VOTES = new Set(['yes', 'no', 'up', 'down', 'helpful', 'not_helpful', 'thumbs_up', 'thumbs_down']);

/** Control characters never belong in a stored label (same rule telemetry uses). */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(CONTROL_CHARS, '').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Plain JSON object only: no array, no scalar, no class instance with a
    `__proto__` in it. Rejects rather than coerces — a caller that sent an
    array should hear about it instead of watching it vanish. */
function plainObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return null;
  return v as Record<string, unknown>;
}

/** `feedback.document`, `feedback.ui`, … — the kind is namespaced so a
    feedback row can never be mistaken for, or mixed into, an auth/security
    row, and the admin list can filter on the `feedback.` prefix. */
function normalizeKind(raw: unknown): string {
  const k = clean(raw, LIMITS.kind)?.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^\.+|\.+$/g, '');
  if (!k) return 'feedback.general';
  return k.startsWith('feedback.') ? k : `feedback.${k}`;
}

function normalizeVote(raw: unknown): string | null {
  if (typeof raw === 'boolean') return raw ? 'yes' : 'no';
  const v = clean(raw, 20)?.toLowerCase().replace(/[\s-]+/g, '_');
  return v && VOTES.has(v) ? v : null;
}

/** A short human summary — the row's `title`, so it must read as a sentence
    fragment and never as the machine key. */
function buildTitle(parts: { kind: string; vote: string | null; page: string | null; articleId: string | null; hasComment: boolean }): string {
  const subject =
    parts.articleId ? `“${parts.articleId}”`
      : parts.page ? `on ${parts.page.length > 48 ? `${parts.page.slice(0, 47)}…` : parts.page}`
        : '';
  const verdict = parts.vote ? ` ${parts.vote}` : parts.hasComment ? ' comment' : '';
  const raw = `${parts.kind.replace(/^feedback\./, '')} feedback${verdict}${subject ? ` ${subject}` : ''}`;
  const title = raw.charAt(0).toUpperCase() + raw.slice(1);
  return title.length > LIMITS.title ? `${title.slice(0, LIMITS.title - 1)}…` : title;
}

/** Own feedback: POST /api/feedback. Answers `{ ok, id, message }`. */
export async function feedbackHandler(request: NextRequest) {
  try {
    if (request.method === 'GET') return ownFeedback(request);

    const body = plainObject(await request.json().catch(() => null));
    if (!body) {
      return NextResponse.json({ error: 'Feedback must be a JSON object', code: 'INVALID_FEEDBACK_BODY' }, { status: 400 });
    }

    const kind = normalizeKind(body.kind);
    const source = clean(body.source, LIMITS.source);
    const page = clean(body.page, LIMITS.page) ?? clean(body.path, LIMITS.page) ?? clean(body.slug, LIMITS.page);
    const articleId = clean(body.articleId, LIMITS.articleId) ?? clean(body.id, LIMITS.articleId);
    const vote = normalizeVote(body.vote);
    const rating = typeof body.rating === 'number' && Number.isFinite(body.rating)
      ? Math.max(0, Math.min(10, Math.round(body.rating)))
      : null;
    const comment = clean(body.comment, LIMITS.comment) ?? clean(body.message, LIMITS.comment) ?? clean(body.text, LIMITS.comment);
    const detail = clean(body.detail, LIMITS.detail);

    // Caller-supplied metadata: plain object, JSON-safe, ≤ 4 KB — or refused.
    let metadata: Record<string, unknown> = {};
    if (body.metadata !== undefined) {
      const meta = plainObject(body.metadata);
      if (!meta) {
        return NextResponse.json({ error: 'metadata must be a plain JSON object', code: 'INVALID_FEEDBACK_METADATA' }, { status: 400 });
      }
      let serialized: string | null = null;
      try { serialized = JSON.stringify(meta); } catch { serialized = null; }
      if (!serialized) {
        return NextResponse.json({ error: 'metadata is not serializable', code: 'INVALID_FEEDBACK_METADATA' }, { status: 400 });
      }
      if (serialized.length > LIMITS.metadataBytes) {
        return NextResponse.json({ error: 'metadata is too large', code: 'FEEDBACK_METADATA_TOO_LARGE' }, { status: 413 });
      }
      metadata = JSON.parse(serialized) as Record<string, unknown>;
    }

    // Anything the client sent that isn't a named field rides along inside
    // metadata.extras (bounded) rather than being silently thrown away.
    const named = new Set(['kind', 'source', 'page', 'path', 'slug', 'articleId', 'id', 'vote', 'rating', 'comment', 'message', 'text', 'detail', 'metadata']);
    const extras = Object.fromEntries(Object.entries(body).filter(([k]) => !named.has(k)).slice(0, LIMITS.maxFields));
    if (Object.keys(extras).length > 0) metadata = { ...metadata, extras };

    // Nothing sayable in it → nothing stored.
    if (!vote && !comment && !rating && !detail && Object.keys(metadata).length === 0) {
      return NextResponse.json({ error: 'Feedback is empty', code: 'EMPTY_FEEDBACK' }, { status: 400 });
    }

    // Attribution is the session's, never the payload's: a `userId` field in
    // the body is stored as what it is — text someone sent — not as the actor.
    const session = await getSession(request);
    const ip = getClientIp(request);

    const row = await prisma.activityEvent.create({
      data: {
        userId: session?.userId ?? null,
        kind,
        title: buildTitle({ kind, vote, page, articleId, hasComment: !!comment }),
        detail: comment || detail,
        severity: 'info',
        ipAddress: ip,
        userAgent: getUserAgent(request),
        metadata: {
          ...metadata,
          ...(source ? { source } : {}),
          ...(page ? { page } : {}),
          ...(articleId ? { articleId } : {}),
          ...(vote ? { vote } : {}),
          ...(rating !== null ? { rating } : {}),
          ...(comment ? { comment: comment.slice(0, LIMITS.comment) } : {}),
          anonymous: !session,
        } as any,
      },
      select: { id: true, createdAt: true },
    });

    return NextResponse.json({ ok: true, id: row.id, createdAt: row.createdAt.toISOString(), message: 'Feedback received' });
  } catch (err: any) {
    console.error('[FEEDBACK]', err?.message || err);
    return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500 });
  }
}

/** The caller's own rows — the "what did I tell you?" read. */
async function ownFeedback(request: NextRequest) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Sign in to read your feedback' }, { status: 401 });
  }
  const { page, limit, skip, take } = paging(request);
  const where = { userId: session.userId, kind: { startsWith: 'feedback.' } };
  const [rows, total] = await Promise.all([
    prisma.activityEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.activityEvent.count({ where }),
  ]);
  return NextResponse.json({ ok: true, feedback: rows.map(shapeRow), total, page, limit });
}

/** GET /api/admin/feedback — staff read, newest first, paged. */
export async function adminFeedbackHandler(request: NextRequest) {
  try {
    const guard = await requireRole(request, 'manager');
    if (guard instanceof NextResponse) return guard;

    const { page, limit, skip, take } = paging(request);
    const kind = clean(request.nextUrl.searchParams.get('kind'), LIMITS.kind);
    const vote = normalizeVote(request.nextUrl.searchParams.get('vote'));
    const userId = clean(request.nextUrl.searchParams.get('userId'), 64);
    const search = clean(request.nextUrl.searchParams.get('search'), 120);

    const where: any = { kind: kind ? (kind.startsWith('feedback.') ? kind : `feedback.${kind}`) : { startsWith: 'feedback.' } };
    if (userId) where.userId = userId;
    if (vote) where.metadata = { path: ['vote'], equals: vote };
    if (search) {
      where.OR = [
        { title: { contains: search } },
        { detail: { contains: search } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.activityEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true, userId: true, kind: true, title: true, detail: true, severity: true,
          metadata: true, createdAt: true, ipAddress: true, userAgent: true,
          user: { select: { id: true, email: true, username: true } },
        },
      }),
      prisma.activityEvent.count({ where }),
    ]);

    return NextResponse.json({
      ok: true,
      feedback: rows.map((r) => ({ ...shapeRow(r as any), user: r.user ? { id: r.user.id, email: r.user.email, username: r.user.username } : null })),
      total,
      page,
      limit,
    });
  } catch (err: any) {
    console.error('[ADMIN FEEDBACK]', err?.message || err);
    return NextResponse.json({ error: 'Failed to read feedback' }, { status: 500 });
  }
}

function paging(request: NextRequest) {
  const rawPage = Number(request.nextUrl.searchParams.get('page')) || 1;
  const rawLimit = Number(request.nextUrl.searchParams.get('limit')) || 20;
  const page = Math.max(1, Math.floor(rawPage));
  const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

/** Row → what a screen reads. `title` falls back to the human form of the key
    for any row written before titles were summaries, so the list never shows
    `feedback.document` where a sentence belongs. */
function shapeRow(row: any) {
  const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
  return {
    id: row.id,
    kind: row.kind,
    title: row.title && row.title !== row.kind ? row.title : humanTitle(row.kind),
    detail: row.detail ?? null,
    severity: row.severity ?? 'info',
    userId: row.userId ?? null,
    vote: typeof meta.vote === 'string' ? meta.vote : null,
    rating: typeof meta.rating === 'number' ? meta.rating : null,
    page: typeof meta.page === 'string' ? meta.page : null,
    articleId: typeof meta.articleId === 'string' ? meta.articleId : null,
    source: typeof meta.source === 'string' ? meta.source : null,
    comment: typeof meta.comment === 'string' ? meta.comment : null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    metadata: meta,
  };
}
