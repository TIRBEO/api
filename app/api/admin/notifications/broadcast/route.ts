import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/infrastructure/db/prisma';
import { withPermission } from '@/features/auth/permission-guard';
import { createNotification } from '@/features/notifications/notifications';
import { sendBroadcastWs } from '@/infrastructure/realtime/ws-deliver';

/**
 * Who may be mailed a product update, read from the stores that actually
 * decide it: the account status on users, the person's own switches on
 * user_preferences.notif (the only place the settings screens write), the
 * verified login address on user_email, and the display name on user_profile.
 * These predicates used to name users.notification_preferences,
 * users.email_verified, users.is_banned and users.name — columns this schema
 * does not have, so every query here failed and the broadcast sent nothing.
 */
const emailedScope = Prisma.sql`
  FROM "public"."users" u
  LEFT JOIN "public"."user_profile" prof ON prof."user_id" = u."id"
  LEFT JOIN "public"."user_preferences" pr ON pr."user_id" = u."id"
  LEFT JOIN "public"."user_email" e ON e."user_id" = u."id" AND e."is_default" = true
  WHERE u."status" NOT IN ('deleted', 'banned', 'suspended')
    AND COALESCE((pr."notif" ->> 'email')::boolean, true)
    AND COALESCE((pr."notif" ->> 'productEmail')::boolean, false)
    AND e."verified_at" IS NOT NULL`;

/** Recipient count for the composer preview. */
export const GET = withPermission('notifications.read', async () => {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n ${emailedScope}`;
  return NextResponse.json({ recipients: Number(rows[0]?.n ?? 0) });
});

/**
 * Product-update broadcast.
 * Sends an email ONLY to users who opted in to product emails and are active.
 *
 * Bounded on purpose. This used to take up to 10,000 recipients and mail them
 * one at a time inside the request — which cannot finish (a Hobby function
 * stops at 10s, so it died after a few dozen), cannot be retried without
 * re-mailing the people who already got it, and then fired 10,000 un-awaited
 * `createNotification` promises at the connection pool on the way out. The
 * numbers below are what one request can actually finish; a bigger audience is
 * refused loudly rather than served partially.
 */
const BROADCAST_MAX = 200;
const BROADCAST_CONCURRENCY = 8;
const BROADCAST_DEADLINE_MS = 8_000;

export const POST = withPermission('notifications.send', async (request: NextRequest) => {
  const body: any = await request.json();
  const title = String(body.title || '').trim();
  const message = String(body.message || '').trim();
  const ctaUrl = String(body.ctaUrl || '').trim() || '/dashboard';
  const ctaLabel = String(body.ctaLabel || '').trim() || "See What's New";

  if (!title || title.length > 120) {
    return NextResponse.json({ error: 'Title is required (max 120 chars)' }, { status: 400 });
  }
  if (!message || message.length > 5000) {
    return NextResponse.json({ error: 'Message is required (max 5000 chars)' }, { status: 400 });
  }

  type Row = { id: string; email: string; name: string | null };
  // One row over the cap is all the read needed to know the audience is too
  // big for this endpoint — nothing is sent before the answer.
  const recipients = await prisma.$queryRaw<Row[]>`
    SELECT u."id", u."email", prof."name" ${emailedScope}
    LIMIT ${BROADCAST_MAX + 1}`;

  if (recipients.length > BROADCAST_MAX) {
    return NextResponse.json({
      error: `This broadcast reaches more than ${BROADCAST_MAX} people and cannot be sent from one request. Nothing was sent.`,
      code: 'broadcast_too_large',
      limit: BROADCAST_MAX,
      optedIn: recipients.length - 1,
    }, { status: 409 });
  }

  if (recipients.length === 0) {
    return NextResponse.json({ sent: 0, failed: 0, message: 'No opted-in recipients' });
  }

  const { sendTemplateEmail } = await import('@/features/email/email');
  const { getDashboardBaseUrl } = await import('@/config/app-urls');
  const dashboardUrl = getDashboardBaseUrl();
  const deadlineAt = Date.now() + BROADCAST_DEADLINE_MS;

  let sent = 0;
  let failed = 0;
  let notSent = 0;
  const queue = recipients.filter((u) => !!u.email);
  // A fixed pool of workers, not one send per recipient in series: the
  // provider's latency is the same either way, and eight at a time is eight
  // times fewer seconds.
  const workers = Array.from({ length: Math.min(BROADCAST_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (Date.now() > deadlineAt) { notSent++; continue; }
      try {
        const result = await sendTemplateEmail(next.email, 'product_update', {
          name: next.name || next.email,
          title,
          message,
          ctaUrl: ctaUrl.startsWith('http') ? ctaUrl : `${dashboardUrl}${ctaUrl}`,
          ctaLabel,
          dashboardUrl,
        }, { userId: next.id });
        if (result.success) sent++; else failed++;
      } catch {
        failed++;
      }
    }
  });
  await Promise.all(workers);

  console.log(`[BROADCAST] Product update "${title}" — ${sent} sent, ${failed} failed, ${notSent} not reached in time`);

  // Also create in-app notifications for everyone who takes product notices —
  // that channel answers to productPush, not to the email switch.
  const allProductUsers = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT u."id"
    FROM "public"."users" u
    LEFT JOIN "public"."user_preferences" pr ON pr."user_id" = u."id"
    WHERE u."status" NOT IN ('deleted', 'banned', 'suspended')
      AND COALESCE((pr."notif" ->> 'productPush')::boolean, true)
    LIMIT 10000`;

  // In-app only: the mail above already reached the opted-in ones, and
  // `createNotification` mails on its own when the account's email switch is
  // open — which, unskipped here, put a second copy of every broadcast in the
  // same inbox. Chunked rather than all-fired-at-once, because each call is a
  // handful of queries and 10,000 of them at once is a self-inflicted outage.
  const NOTIFY_CHUNK = 25;
  for (let i = 0; i < allProductUsers.length; i += NOTIFY_CHUNK) {
    await Promise.all(allProductUsers.slice(i, i + NOTIFY_CHUNK).map((u) =>
      createNotification({
        userId: u.id,
        type: 'product',
        title,
        body: message.slice(0, 200),
        link: ctaUrl.startsWith('http') ? ctaUrl : `/home`,
        skipEmail: true,
      }).catch(() => {})));
  }

  // Broadcast WS event to all connected users
  sendBroadcastWs({
    type: 'product_update',
    title,
    body: message.slice(0, 200),
    ctaUrl,
    ctaLabel,
  }).catch(() => {});

  return NextResponse.json({ sent, failed, notSent, total: recipients.length });
});
