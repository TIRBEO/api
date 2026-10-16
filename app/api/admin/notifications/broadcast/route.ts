import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/infrastructure/db/prisma';
import { withAdmin } from '@/features/auth/role-guard';
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
export const GET = withAdmin(async () => {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n ${emailedScope}`;
  return NextResponse.json({ recipients: Number(rows[0]?.n ?? 0) });
});

/**
 * Product-update broadcast.
 * Sends an email ONLY to users who opted in to product emails and are active.
 */
export const POST = withAdmin(async (request: NextRequest) => {
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
  const recipients = await prisma.$queryRaw<Row[]>`
    SELECT u."id", u."email", prof."name" ${emailedScope}
    LIMIT 10000`;

  if (recipients.length === 0) {
    return NextResponse.json({ sent: 0, failed: 0, message: 'No opted-in recipients' });
  }

  const { sendTemplateEmail } = await import('@/features/email/email');
  const { getDashboardBaseUrl } = await import('@/config/app-urls');
  const dashboardUrl = getDashboardBaseUrl();

  let sent = 0;
  let failed = 0;
  for (const u of recipients) {
    if (!u.email) continue;
    try {
      const result = await sendTemplateEmail(u.email, 'product_update', {
        name: u.name || u.email,
        title,
        message,
        ctaUrl: ctaUrl.startsWith('http') ? ctaUrl : `${dashboardUrl}${ctaUrl}`,
        ctaLabel,
        dashboardUrl,
      }, { userId: u.id });
      if (result.success) sent++; else failed++;
    } catch {
      failed++;
    }
  }

  console.log(`[BROADCAST] Product update "${title}" — ${sent} sent, ${failed} failed`);

  // Also create in-app notifications for everyone who takes product notices —
  // that channel answers to productPush, not to the email switch.
  const allProductUsers = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT u."id"
    FROM "public"."users" u
    LEFT JOIN "public"."user_preferences" pr ON pr."user_id" = u."id"
    WHERE u."status" NOT IN ('deleted', 'banned', 'suspended')
      AND COALESCE((pr."notif" ->> 'productPush')::boolean, true)
    LIMIT 10000`;

  for (const u of allProductUsers) {
    createNotification({
      userId: u.id,
      type: 'product',
      title,
      body: message.slice(0, 200),
      link: ctaUrl.startsWith('http') ? ctaUrl : `/home`,
    }).catch(() => {});
  }

  // Broadcast WS event to all connected users
  sendBroadcastWs({
    type: 'product_update',
    title,
    body: message.slice(0, 200),
    ctaUrl,
    ctaLabel,
  }).catch(() => {});

  return NextResponse.json({ sent, failed, total: recipients.length });
});
