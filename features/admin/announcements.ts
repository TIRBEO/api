import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/infrastructure/db/prisma';
import { escapeHtml } from '@/features/email/email';
import { consumeGenericWindow } from '@/features/auth/verify-limits';

/* ═══════════════════════════════════════════════════════════════════
   Announcements and console mail — what the platform says to everyone

   Two kinds of one-voice message, kept apart because they reach people
   through different doors and the record each leaves is different:

   · An announcement is an in-app notice: one row per account in
     `notifications`, tagged with the announcement's id in its metadata.
     The announcement itself is a row in `activity_events` (kind
     `announcement.sent`) — no new table for what is already a ledger
     entry, and the ledger is where the audit screen already looks.
     "Who opened it" is answered from the notice rows: `isRead`, and the
     `readAt` the mark-read path stamps into their metadata.

   · Console mail is a composed email sent through the same provider and
     the same product-update shell every brand mail wears, so an
     operator's words cannot arrive looking like a spoof of the platform.
     The body is written as plain text; the server escapes it, breaks it
     into paragraphs and links bare URLs. No raw HTML from the composer —
     an inbox is not a place to run somebody's markup.

   Both are bounded the way the broadcast is: a fixed ceiling per request,
   a deadline, and a loud refusal rather than a silent half-send.
   ═══════════════════════════════════════════════════════════════════ */

const ANNOUNCE_KIND = 'announcement.sent';
const MAIL_KIND = 'admin.mail.sent';

/** One operator may fire a few of these a day, not a few hundred. */
const SEND_WINDOW_MS = 15 * 60 * 1000;
const SENDS_PER_WINDOW = 3;

const IN_APP_MAX = 10_000;
const MAIL_MAX = 200;
const MAIL_CONCURRENCY = 8;
const MAIL_DEADLINE_MS = 8_000;

/** Mailboxes that exist and are the account's own: verified default
    address, account not closed. `product` narrows to who opted in to
    product mail — the only audience a composed mail may be aimed at,
    because the send itself honours the switch and a "all users" list
    full of opted-out addresses is 200 suppressions dressed as a send. */
function audienceScope(audience: string): Prisma.Sql {
  const closed = Prisma.sql`u."status" NOT IN ('deleted', 'banned', 'suspended')`;
  const mailbox = Prisma.sql`e."verified_at" IS NOT NULL`;
  if (audience === 'product') {
    return Prisma.sql`WHERE ${closed} AND ${mailbox}
      AND COALESCE((pr."notif" ->> 'email')::boolean, true)
      AND COALESCE((pr."notif" ->> 'productEmail')::boolean, false)`;
  }
  return Prisma.sql`WHERE ${closed} AND ${mailbox}`;
}

const AUDIENCE_JOINS = Prisma.sql`
  FROM "public"."users" u
  LEFT JOIN "public"."user_profile" prof ON prof."user_id" = u."id"
  LEFT JOIN "public"."user_preferences" pr ON pr."user_id" = u."id"
  LEFT JOIN "public"."user_email" e ON e."user_id" = u."id" AND e."is_default" = true`;

/** GET /api/admin/announcements/audiences — how big each door is, before
    anybody commits to walking through it. */
export async function audiencesHandler(_request: NextRequest) {
  const [active, mailboxes, productMail, inApp] = await Promise.all([
    prisma.user.count({ where: { status: { notIn: ['deleted', 'banned', 'suspended'] } } }),
    prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n ${AUDIENCE_JOINS} ${audienceScope('all')}`,
    prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n ${AUDIENCE_JOINS} ${audienceScope('product')}`,
    prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n
      FROM "public"."users" u
      LEFT JOIN "public"."user_preferences" pr ON pr."user_id" = u."id"
      WHERE u."status" NOT IN ('deleted', 'banned', 'suspended')
        AND COALESCE((pr."notif" ->> 'productPush')::boolean, true)`,
  ]);
  return NextResponse.json({
    ok: true,
    audiences: {
      active,
      mailboxes: Number(mailboxes[0]?.n ?? 0),
      productMail: Number(productMail[0]?.n ?? 0),
      inApp: Number(inApp[0]?.n ?? 0),
    },
  });
}

/** GET /api/admin/announcements/stats — the numbers the graphs draw.

    Three questions, answered from the same rows the senders write:

    · Did the notice get read? The per-account notice rows carry `isRead`
      and the `readAt` the bell stamps — delivered vs opened, by day.
    · Did the mail land? The ledger metadata carries sent/failed per send;
      the mail log carries opens and clicks per address.
    · Is the audience growing? A 30-day series of sends and opens, so a
    flat line is visible before it becomes a habit. */
export async function announcementStatsHandler(_request: NextRequest) {
  const since = new Date(Date.now() - 29 * 24 * 3600_000);

  const [noticeRow, mailSendRow, mailLogRow, dailySends, dailyNoticeOpens, dailyMailOpens] = await Promise.all([
    prisma.$queryRaw<Array<{ delivered: bigint; opened: bigint }>>`
      SELECT COUNT(*)::bigint AS delivered,
             COUNT(*) FILTER (WHERE "is_read" = true)::bigint AS opened
      FROM "public"."notifications"
      WHERE "type" = 'product' AND "metadata" ->> 'announcementId' IS NOT NULL`,
    prisma.$queryRaw<Array<{ sent: bigint; failed: bigint }>>`
      SELECT COALESCE(SUM(("metadata" ->> 'sent')::int), 0)::bigint AS sent,
             COALESCE(SUM(("metadata" ->> 'failed')::int), 0)::bigint AS failed
      FROM "public"."activity_events"
      WHERE "kind" = ${MAIL_KIND}`,
    prisma.$queryRaw<Array<{ delivered: bigint; opened: bigint; clicked: bigint }>>`
      SELECT COUNT(*)::bigint AS delivered,
             COUNT(*) FILTER (WHERE "opened_at" IS NOT NULL)::bigint AS opened,
             COUNT(*) FILTER (WHERE "clicked_at" IS NOT NULL)::bigint AS clicked
      FROM "public"."email_deliveries"
      WHERE "category" = 'product'`,
    prisma.$queryRaw<Array<{ day: string; announcements: bigint; mails: bigint }>>`
      SELECT to_char(date_trunc('day', "created_at"), 'YYYY-MM-DD') AS day,
             COUNT(*) FILTER (WHERE "kind" = ${ANNOUNCE_KIND})::bigint AS announcements,
             COUNT(*) FILTER (WHERE "kind" = ${MAIL_KIND})::bigint AS mails
      FROM "public"."activity_events"
      WHERE "kind" IN (${ANNOUNCE_KIND}, ${MAIL_KIND}) AND "created_at" >= ${since}
      GROUP BY 1`,
    prisma.$queryRaw<Array<{ day: string; opens: bigint }>>`
      SELECT substring("metadata" ->> 'readAt' for 10) AS day, COUNT(*)::bigint AS opens
      FROM "public"."notifications"
      WHERE "type" = 'product'
        AND "metadata" ->> 'announcementId' IS NOT NULL
        AND "is_read" = true
        AND "metadata" ->> 'readAt' IS NOT NULL
        AND substring("metadata" ->> 'readAt' for 10) >= to_char(${since}::date, 'YYYY-MM-DD')
      GROUP BY 1`,
    prisma.$queryRaw<Array<{ day: string; opens: bigint }>>`
      SELECT to_char(date_trunc('day', "opened_at"), 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS opens
      FROM "public"."email_deliveries"
      WHERE "category" = 'product' AND "opened_at" >= ${since}
      GROUP BY 1`,
  ]);

  const byDay = new Map<string, { date: string; announcements: number; mails: number; noticeOpens: number; mailOpens: number }>();
  for (let i = 0; i < 30; i += 1) {
    const d = new Date(Date.now() - (29 - i) * 24 * 3600_000);
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, { date: key, announcements: 0, mails: 0, noticeOpens: 0, mailOpens: 0 });
  }
  for (const r of dailySends) {
    const slot = byDay.get(r.day);
    if (slot) { slot.announcements = Number(r.announcements); slot.mails = Number(r.mails); }
  }
  for (const r of dailyNoticeOpens) {
    const slot = byDay.get(r.day);
    if (slot) slot.noticeOpens += Number(r.opens);
  }
  for (const r of dailyMailOpens) {
    const slot = byDay.get(r.day);
    if (slot) slot.mailOpens += Number(r.opens);
  }

  return NextResponse.json({
    ok: true,
    stats: {
      notices: {
        delivered: Number(noticeRow[0]?.delivered ?? 0),
        opened: Number(noticeRow[0]?.opened ?? 0),
      },
      mails: {
        sent: Number(mailSendRow[0]?.sent ?? 0),
        failed: Number(mailSendRow[0]?.failed ?? 0),
        logged: Number(mailLogRow[0]?.delivered ?? 0),
        opened: Number(mailLogRow[0]?.opened ?? 0),
        clicked: Number(mailLogRow[0]?.clicked ?? 0),
      },
      daily: [...byDay.values()],
    },
  });
}

/** The opened-counts for a page of announcement ids, in one grouped read
    rather than one count per row. */
async function openStats(ids: string[]): Promise<Map<string, { total: number; opened: number }>> {
  const out = new Map<string, { total: number; opened: number }>();
  if (!ids.length) return out;
  const rows = await prisma.$queryRaw<Array<{ aid: string; total: bigint; opened: bigint }>>`
    SELECT n."metadata" ->> 'announcementId' AS aid,
           COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE n."is_read" = true)::bigint AS opened
    FROM "public"."notifications" n
    WHERE n."metadata" ->> 'announcementId' IN (${Prisma.join(ids)})
    GROUP BY 1`;
  for (const r of rows) out.set(r.aid, { total: Number(r.total), opened: Number(r.opened) });
  return out;
}

/** GET /api/admin/announcements — the sent list, newest first, each row
    carrying how many people it reached and how many opened it. */
export async function announcementsListHandler(request: NextRequest) {
  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 25));

  const events = await prisma.activityEvent.findMany({
    where: { kind: { in: [ANNOUNCE_KIND, MAIL_KIND] } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, kind: true, title: true, detail: true, metadata: true, createdAt: true },
  });

  const noticeIds = events.filter((e) => e.kind === ANNOUNCE_KIND).map((e) => e.id);
  const stats = await openStats(noticeIds);

  return NextResponse.json({
    ok: true,
    announcements: events.map((e) => {
      const meta = (e.metadata || {}) as Record<string, any>;
      const s = stats.get(e.id);
      return {
        id: e.id,
        kind: e.kind === ANNOUNCE_KIND ? 'announcement' : 'mail',
        title: e.title,
        message: e.detail ?? null,
        ctaUrl: typeof meta.ctaUrl === 'string' ? meta.ctaUrl : null,
        ctaLabel: typeof meta.ctaLabel === 'string' ? meta.ctaLabel : null,
        audience: typeof meta.audience === 'string' ? meta.audience : null,
        subject: typeof meta.subject === 'string' ? meta.subject : null,
        recipients: Number(meta.recipients ?? s?.total ?? 0),
        sent: Number(meta.sent ?? 0),
        failed: Number(meta.failed ?? 0),
        opened: s?.opened ?? 0,
        createdAt: e.createdAt.toISOString(),
      };
    }),
  });
}

/** GET /api/admin/announcements/users — every account that takes product
    mail right now: active, verified mailbox, and `notif.productEmail`
    explicitly on. This is the same predicate `audienceScope('product')`
    selects, so the list is the mail audience — an account that turned
    product mail off is absent here and skipped by the send alike. Search
    narrows by name or address. */
export async function noticeUsersHandler(request: NextRequest) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 120);
  const offset = Math.max(0, Math.min(50_000, Number(url.searchParams.get('offset')) || 0));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 25));

  const where = Prisma.sql`
    ${audienceScope('product')}
      ${q ? Prisma.sql`AND (lower(u."email") LIKE ${'%' + q + '%'} OR lower(prof."name") LIKE ${'%' + q + '%'})` : Prisma.empty}`;

  const [rows, counts] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; email: string; name: string | null; joinedAt: Date; lastNoticeAt: Date | null; lastMailAt: Date | null; mailsOpened: bigint }>>`
      SELECT u."id", u."email", prof."name", u."created_at" AS "joinedAt",
             (SELECT max(n."created_at") FROM "public"."notifications" n
              WHERE n."user_id" = u."id" AND n."type" = 'product') AS "lastNoticeAt",
             (SELECT max(d."created_at") FROM "public"."email_deliveries" d
              WHERE d."user_id" = u."id" AND d."category" = 'product') AS "lastMailAt",
             (SELECT count(*) FROM "public"."email_deliveries" d
              WHERE d."user_id" = u."id" AND d."category" = 'product' AND d."opened_at" IS NOT NULL) AS "mailsOpened"
      ${AUDIENCE_JOINS}
      ${where}
      ORDER BY u."created_at" DESC
      LIMIT ${limit} OFFSET ${offset}`,
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n
      ${AUDIENCE_JOINS}
      ${where}`,
  ]);

  return NextResponse.json({
    ok: true,
    total: Number(counts[0]?.n ?? 0),
    offset,
    users: rows.map((r) => ({
      userId: r.id,
      name: r.name,
      email: r.email,
      joinedAt: r.joinedAt.toISOString(),
      lastNoticeAt: r.lastNoticeAt ? r.lastNoticeAt.toISOString() : null,
      lastMailAt: r.lastMailAt ? r.lastMailAt.toISOString() : null,
      mailsOpened: Number(r.mailsOpened),
    })),
  });
}

/** GET /api/admin/announcements/opens?id= — who the notice went to and
    who actually opened it. Names and addresses are console-grade data:
    this endpoint sits behind the same permission as the list. */
export async function announcementOpensHandler(request: NextRequest) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'An announcement id is required.' }, { status: 400 });

  const rows = await prisma.notification.findMany({
    where: { type: 'product', metadata: { path: ['announcementId'], equals: id } },
    orderBy: [{ isRead: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: 500,
    select: {
      userId: true, isRead: true, metadata: true, createdAt: true,
      user: { select: { email: true, profile: { select: { name: true } } } },
    },
  });

  return NextResponse.json({
    ok: true,
    total: rows.length,
    opened: rows.filter((r) => r.isRead === true).length,
    opens: rows.map((r) => ({
      userId: r.userId,
      name: r.user?.profile?.name ?? null,
      email: r.user?.email ?? null,
      opened: r.isRead === true,
      openedAt: (r.metadata as Record<string, any> | null)?.readAt ?? null,
      sentAt: r.createdAt.toISOString(),
    })),
  });
}

/** Plain-text body → escaped paragraphs with bare URLs linked. This is the
    whole "design" surface on purpose: the shell, colours and footer come
    from the platform's own template, the operator supplies words. */
function composeHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => {
      const escaped = escapeHtml(p.trim()).replace(/\n/g, '<br />');
      const linked = escaped.replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" style="color:#1A73E8">$1</a>',
      );
      return linked ? `<p style="margin:0 0 16px">${linked}</p>` : '';
    })
    .filter(Boolean)
    .join('');
}

/** POST /api/admin/announcements { title, message, ctaUrl?, ctaLabel?, audience? }
    — an in-app notice to every account that takes product notices. */
export async function announcementSendHandler(
  request: NextRequest,
  session: { userId: string } | null = null,
) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 5000) : '';
  const ctaLabel = typeof body.ctaLabel === 'string' ? body.ctaLabel.trim().slice(0, 40) : '';
  const ctaUrl = typeof body.ctaUrl === 'string' ? body.ctaUrl.trim().slice(0, 500) : '';

  if (!title || !message) {
    return NextResponse.json({ error: 'An announcement needs a title and a message.' }, { status: 400 });
  }

  const actorId = session?.userId ?? 'admin';
  const limit = await consumeGenericWindow(`announcement:send:${actorId}`, SENDS_PER_WINDOW, SEND_WINDOW_MS);
  if (!limit.ok) {
    const mins = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 60000));
    return NextResponse.json({ error: `That is this window's third send. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` }, { status: 429 });
  }

  const ledger = await prisma.activityEvent.create({
    data: {
      userId: null,
      kind: ANNOUNCE_KIND,
      title,
      detail: message,
      severity: 'info',
      metadata: { ctaUrl: ctaUrl || null, ctaLabel: ctaLabel || null, audience: 'inApp' },
    },
  });

  const recipients = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT u."id"
    FROM "public"."users" u
    LEFT JOIN "public"."user_preferences" pr ON pr."user_id" = u."id"
    WHERE u."status" NOT IN ('deleted', 'banned', 'suspended')
      AND COALESCE((pr."notif" ->> 'productPush')::boolean, true)
    LIMIT ${IN_APP_MAX}`;

  const { createNotification } = await import('@/features/notifications/notifications');
  const CHUNK = 25;
  let delivered = 0;
  for (let i = 0; i < recipients.length; i += CHUNK) {
    const results = await Promise.allSettled(recipients.slice(i, i + CHUNK).map((u) =>
      createNotification({
        userId: u.id,
        type: 'product',
        title,
        body: message.slice(0, 200),
        link: '/home',
        skipEmail: true,
        metadata: { announcementId: ledger.id },
      })));
    delivered += results.filter((r) => r.status === 'fulfilled').length;
  }

  await prisma.activityEvent.update({
    where: { id: ledger.id },
    data: { metadata: { ctaUrl: ctaUrl || null, ctaLabel: ctaLabel || null, audience: 'inApp', recipients: delivered } },
  });

  const { sendBroadcastWs } = await import('@/infrastructure/realtime/ws-deliver');
  sendBroadcastWs({ type: 'product_update', title, body: message.slice(0, 200), ctaUrl: ctaUrl || '/home', ctaLabel: ctaLabel || "See What's New" }).catch(() => {});

  return NextResponse.json({ ok: true, id: ledger.id, recipients: delivered });
}

/** POST /api/admin/email/send { subject, message, ctaLabel?, ctaUrl? }
    — a composed mail to the product-mail audience, through the platform's
    own product-update shell. There is no "everyone" or "one address"
    audience here on purpose: mail from this screen is product mail, and
    product mail goes only to accounts that switched it on. */
export async function adminMailSendHandler(
  request: NextRequest,
  session: { userId: string } | null = null,
) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 120) : '';
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 5000) : '';
  const ctaLabel = typeof body.ctaLabel === 'string' ? body.ctaLabel.trim().slice(0, 40) : '';
  const ctaUrl = typeof body.ctaUrl === 'string' ? body.ctaUrl.trim().slice(0, 500) : '';

  if (!subject || !message) {
    return NextResponse.json({ error: 'A mail needs a subject and a body.' }, { status: 400 });
  }

  const actorId = session?.userId ?? 'admin';
  const limit = await consumeGenericWindow(`console-mail:send:${actorId}`, SENDS_PER_WINDOW, SEND_WINDOW_MS);
  if (!limit.ok) {
    const mins = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 60000));
    return NextResponse.json({ error: `That is this window's third mail. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` }, { status: 429 });
  }

  type Row = { id: string | null; email: string; name: string | null };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT u."id", e."address" AS email, prof."name" ${AUDIENCE_JOINS} ${audienceScope('product')}
    ORDER BY u."created_at" DESC
    LIMIT ${MAIL_MAX + 1}`;
  if (rows.length > MAIL_MAX) {
    return NextResponse.json({
      error: `That audience is over ${MAIL_MAX} mailboxes and cannot be sent from one request. Nothing was sent — send to a smaller audience, or again for the next slice.`,
      code: 'mail_too_large', limit: MAIL_MAX, matched: rows.length - 1,
    }, { status: 409 });
  }
  const queue: Row[] = rows.filter((r) => !!r.email);

  if (!queue.length) {
    return NextResponse.json({ ok: true, sent: 0, failed: 0, total: 0, message: 'Nobody in that audience has a verified mailbox.' });
  }

  const { sendTemplateEmail } = await import('@/features/email/email');
  const { getDashboardBaseUrl } = await import('@/config/app-urls');
  const dashboardUrl = getDashboardBaseUrl();
  const html = composeHtml(message);
  const deadlineAt = Date.now() + MAIL_DEADLINE_MS;

  let sent = 0, failed = 0, notSent = 0;
  const workers = Array.from({ length: Math.min(MAIL_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (Date.now() > deadlineAt) { notSent++; continue; }
      try {
        const r = await sendTemplateEmail(next.email, 'product_update', {
          name: next.name || next.email,
          title: subject,
          message: html,
          ctaUrl: ctaUrl ? (ctaUrl.startsWith('http') ? ctaUrl : `${dashboardUrl}${ctaUrl}`) : dashboardUrl,
          ctaLabel: ctaLabel || 'Open Tirbeo',
          dashboardUrl,
        }, { userId: next.id ?? undefined, rawVars: ['message'] });
        if (r.success) sent++; else failed++;
      } catch { failed++; }
    }
  });
  await Promise.all(workers);

  await prisma.activityEvent.create({
    data: {
      userId: null,
      kind: MAIL_KIND,
      title: subject,
      detail: message.slice(0, 5000),
      severity: 'info',
      metadata: { subject, audience: 'product', recipients: sent + failed + notSent, sent, failed, notSent },
    },
  });

  return NextResponse.json({ ok: true, sent, failed, notSent, total: sent + failed + notSent });
}
