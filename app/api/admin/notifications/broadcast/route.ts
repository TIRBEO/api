import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { withAdmin } from '@/features/auth/role-guard';
import { createNotification } from '@/features/notifications/notifications';
import { sendBroadcastWs } from '@/infrastructure/realtime/ws-deliver';

/** Recipient count for the composer preview. */
export const GET = withAdmin(async () => {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM "users"
    WHERE "deleted_at" IS NULL AND "is_banned" = false
      AND ("notification_preferences"->>'email')::boolean = true
      AND ("notification_preferences"->>'productEmail')::boolean = true
      AND "email_verified" = true`;
  return NextResponse.json({ recipients: Number(rows[0]?.n ?? 0) });
});

/**
 * Product-update broadcast.
 * Sends an email ONLY to users who opted in to product emails
 * (users.notification_preferences.email AND productEmail) and are active.
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

  type Row = { email: string; name: string | null };
  const recipients = await prisma.$queryRaw<Row[]>`
    SELECT "email", "name" FROM "users"
    WHERE "deleted_at" IS NULL AND "is_banned" = false
      AND ("notification_preferences"->>'email')::boolean = true
      AND ("notification_preferences"->>'productEmail')::boolean = true
      AND "email_verified" = true
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
      });
      if (result.success) sent++; else failed++;
    } catch {
      failed++;
    }
  }

  console.log(`[BROADCAST] Product update "${title}" — ${sent} sent, ${failed} failed`);

  // Also create in-app notifications for all opted-in users (not just email recipients)
  const allProductUsers = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "users"
    WHERE "deleted_at" IS NULL AND "is_banned" = false
      AND COALESCE(("notification_preferences"->>'product')::boolean, true) = true`;
  
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
