import { NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { withPermission } from '@/features/auth/permission-guard';
import { eventRowRef } from '@/features/users/refcode';

/* ═══════════════════════════════════════════════════════════════════
   GET /api/admin/support — the helpdesk queue, read from the ledger

   There is no ticket table, and adding one would have made two records of the
   same conversation: the row the account filed and the row staff worked from,
   free to disagree. So this screen reads the thing every other surface already
   reads — `activity_events` — and threads it by the reference code the account
   was quoted when it filed. One code, one thread, both sides.

   A thread is open until a `support.reply` carries its code. That is a fact
   about the ledger, not a flag somebody has to remember to set, so a reply sent
   from the mail pipeline closes the queue row on its own.
   ═══════════════════════════════════════════════════════════════════ */

const THREAD_KINDS = ['support.request', 'support.reply'];

/** How far back the queue looks. Threads are assembled in one pass, so this is
    the window the page is honest about — a queue that quietly truncated at 300
    and said "4 open" would be worse than one that says how far it read. */
const WINDOW = 300;

type Row = {
  id: string;
  userId: string | null;
  kind: string;
  title: string;
  detail: string | null;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  user: { id: string; email: string; username: string | null; profile: { name: string | null } | null } | null;
};

/** The code a row answers to: the one stamped at the write, else the one its
    own id derives — so a thread predating the stamp still groups with itself. */
function refOf(row: { id: string; metadata: unknown }): string {
  return eventRowRef(row);
}

function text(row: Row): string {
  const meta = (row.metadata || {}) as Record<string, any>;
  // The row's `detail` is capped at 500 characters; the mail carried the whole
  // thing, so the queue shows what the person actually wrote.
  return typeof meta.message === 'string' && meta.message ? meta.message : (row.detail ?? '');
}

function account(row: Row) {
  if (!row.user) return null;
  return {
    id: row.user.id,
    email: row.user.email,
    username: row.user.username,
    name: row.user.profile?.name ?? null,
  };
}

export const GET = withPermission('tickets.read', async (request) => {
  try {
    const sp = request.nextUrl.searchParams;
    const status = (sp.get('status') || 'all').toLowerCase();
    const q = (sp.get('q') || '').trim().slice(0, 120);
    const limit = Math.min(100, Math.max(1, Number(sp.get('limit')) || 25));
    const offset = Math.max(0, Number(sp.get('offset')) || 0);

    const where: Record<string, any> = { kind: { in: THREAD_KINDS } };
    if (q) {
      const contains = { contains: q, mode: 'insensitive' as const };
      where.OR = [
        { title: contains },
        { detail: contains },
        { user: { email: contains } },
        { user: { username: contains } },
      ];
      // A pasted reference is the most precise search an operator has — the
      // dashed code lives in metadata, so match its digits too.
      const digits = q.replace(/[^0-9a-f]/gi, '').toLowerCase();
      if (digits.length >= 6) where.OR.push({ metadata: { path: ['refCode'], equals: digits } });
    }

    const rows = await prisma.activityEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: WINDOW,
      select: {
        id: true, userId: true, kind: true, title: true, detail: true, metadata: true,
        ipAddress: true, userAgent: true, createdAt: true,
        user: { select: { id: true, email: true, username: true, profile: { select: { name: true } } } },
      },
    }) as unknown as Row[];

    /* Group by code, oldest-first inside a group so a thread reads in the order
       it happened. A row whose code no other row shares still becomes a thread:
       an answer that arrived for a question outside this window is precisely
       what an operator needs to see, not something to drop. */
    const threads = new Map<string, { rows: Row[]; asked: Row | null }>();
    for (const row of rows) {
      const code = refOf(row);
      const found = threads.get(code) ?? { rows: [], asked: null as Row | null };
      found.rows.push(row);
      if (row.kind === 'support.request' && (!found.asked || row.createdAt < found.asked.createdAt)) found.asked = row;
      threads.set(code, found);
    }

    const items = [...threads.entries()].map(([ref, thread]) => {
      const sorted = [...thread.rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const asked = thread.asked ?? sorted[0];
      const replies = sorted.filter((r) => r.kind === 'support.reply');
      const last = sorted[sorted.length - 1];
      const meta = (asked.metadata || {}) as Record<string, any>;
      return {
        ref,
        subject: asked.title,
        message: text(asked),
        status: replies.length ? 'answered' : 'open',
        askedAt: asked.createdAt.toISOString(),
        answeredAt: replies.length ? replies[replies.length - 1].createdAt.toISOString() : null,
        lastAt: last.createdAt.toISOString(),
        replies: replies.length,
        account: account(asked),
        device: typeof meta.device === 'string' ? meta.device : null,
        location: typeof meta.location === 'string' ? meta.location : null,
        ip: asked.ipAddress,
        channel: typeof meta.channel === 'string' ? meta.channel : null,
      };
    });

    const filtered = (status === 'open' || status === 'answered'
      ? items.filter((t) => t.status === status)
      : items).sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));

    return NextResponse.json({
      threads: filtered.slice(offset, offset + limit),
      total: filtered.length,
      open: items.filter((t) => t.status === 'open').length,
      answered: items.filter((t) => t.status === 'answered').length,
      window: rows.length,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err: any) {
    console.error('[ADMIN SUPPORT QUEUE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to read the queue' }, { status: 500 });
  }
});
