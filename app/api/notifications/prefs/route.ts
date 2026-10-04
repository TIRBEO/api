import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';
import { checkRateLimit, loadNotificationPrefs, saveNotificationPrefs } from '@/features/notifications/notifications';

export const runtime = 'nodejs';

// What a settings screen is allowed to decide. Security is not on this list:
// nobody can opt out of being told their own account was breached.
const ALLOWED_FIELDS = [
  // Global channels
  'email', 'push',
  // Category toggles (forms, product, support)
  'forms', 'product', 'support',
  // Per-category x channel matrix
  'formsEmail', 'formsPush',
  'productEmail', 'productPush',
  'supportEmail', 'supportPush',
  'offers', 'offersEmail', 'offersPush',
  'tips', 'tipsEmail', 'tipsPush',
  // Periodic account recap: whether it comes at all, and how often
  'summaryEnabled', 'summaryFrequency',
  // Pause everything at once — codes and security alerts still get through.
  // `emailPausedUntil` is the epoch ms it lapses at, or null for "until I say
  // so", so an expired date reads as unpaused without anyone running a job.
  'emailPaused', 'emailPausedUntil',
] as const;

const SUMMARY_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;
    return NextResponse.json(await loadNotificationPrefs(session.userId));
  } catch (err: any) {
    console.error('[NOTIFICATIONS] Get prefs error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch preferences' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;

    // Per-user rate-limit: 20 prefs updates/min (matrix has 7 toggles + digest)
    const { allowed, remaining } = await checkRateLimit(`prefs:${session.userId}`, 20, 60);
    if (!allowed) {
      return NextResponse.json({ error: 'Too many updates — try in 60s' }, { status: 429, headers: { 'Retry-After': '60', 'X-RateLimit-Remaining': String(remaining) } });
    }

    const body: any = await request.json();

    const data: Record<string, any> = {};
    for (const key of ALLOWED_FIELDS) {
      if (body[key] !== undefined) data[key] = body[key];
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    if (data.summaryFrequency !== undefined && !SUMMARY_FREQUENCIES.has(data.summaryFrequency)) {
      return NextResponse.json({ error: 'Invalid summaryFrequency' }, { status: 400 });
    }
    // A pause that says nothing about when it ends is a real number or nothing
    // at all; anything else would be read as "unpaused" by isEmailPaused and the
    // person would keep getting mail while the screen shows the switch on.
    if (data.emailPausedUntil !== undefined
        && data.emailPausedUntil !== null
        && !(typeof data.emailPausedUntil === 'number' && Number.isFinite(data.emailPausedUntil))) {
      return NextResponse.json({ error: 'Invalid emailPausedUntil' }, { status: 400 });
    }

    // Re-enabling mail globally means the person wants it back, so the category
    // emails that the global switch turned off come back too — unless this same
    // request said otherwise. This has to happen before the write: it used to run
    // after, so the reply promised the toggles were back while the account still
    // had them off.
    if (data.email === true) {
      if (data.formsEmail === undefined) data.formsEmail = true;
      if (data.productEmail === undefined) data.productEmail = true;
      if (data.supportEmail === undefined) data.supportEmail = true;
    }

    const prefs = await saveNotificationPrefs(session.userId, data);

    if (data.email === true) {
      try {
        const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { emailUnsubscribed: true } });
        const eu: any = (user as any)?.emailUnsubscribed || {};
        if (eu.all || eu.product || eu.forms || eu.support) {
          eu.all = false;
          eu.product = false;
          eu.forms = false;
          eu.support = false;
          await prisma.$executeRaw`
            UPDATE "user"."users" SET "email_unsubscribed" = ${JSON.stringify(eu)}::jsonb
            WHERE "id" = ${session.userId}`;
          console.log(`[NOTIFICATIONS] Cleared emailUnsub flags for user ${session.userId} (email re-enabled)`);
        }
      } catch { /* non-fatal */ }
    }

    return NextResponse.json(prefs);
  } catch (err: any) {
    console.error('[NOTIFICATIONS] Update prefs error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 });
  }
}
