import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/db/prisma';
import { withAdmin } from '@/lib/role-guard';

const OPT_IN_WHERE = {
  email: true,
  productEmail: true,
  user: { deletedAt: null, isBanned: false },
} as const;

/** Recipient count for the composer preview. */
export const GET = withAdmin(async () => {
  const count = await prisma.notificationPreference.count({ where: OPT_IN_WHERE });
  return NextResponse.json({ recipients: count });
});

/**
 * Product-update broadcast.
 * Sends an email ONLY to users who opted in to product emails
 * (notification_preferences.email AND product_email) and are active.
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

  const prefs = await prisma.notificationPreference.findMany({
    where: OPT_IN_WHERE,
    select: { user: { select: { email: true, name: true } } },
    take: 10000,
  });

  if (prefs.length === 0) {
    return NextResponse.json({ sent: 0, failed: 0, message: 'No opted-in recipients' });
  }

  const { sendTemplateEmail } = await import('../../../../../lib/email');
  const { getDashboardBaseUrl } = await import('../../../../../lib/app-urls');
  const dashboardUrl = getDashboardBaseUrl();

  let sent = 0;
  let failed = 0;
  for (const p of prefs) {
    if (!p.user?.email) continue;
    try {
      const result = await sendTemplateEmail(p.user.email, 'product_update', {
        name: p.user.name || p.user.email,
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
  return NextResponse.json({ sent, failed, total: prefs.length });
});
