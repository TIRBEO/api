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
  // The tips master is the one category-level switch a send path still reads
  // (emailPrefs tips gate). The forms/product/support/offers masters were
  // writable but read by nothing — screens decide through the channel keys
  // below, so those dead keys are no longer accepted here.
  'tips',
  // Per-category x channel matrix
  'formsEmail', 'formsPush',
  'productEmail', 'productPush',
  'supportEmail', 'supportPush',
  'offersEmail', 'offersPush',
  'tipsEmail', 'tipsPush',
  // Periodic account recap: whether it comes at all, and how often
  'summaryEnabled', 'summaryFrequency',
  // Pause everything at once — codes and security alerts still get through.
  // `emailPausedUntil` is the epoch ms it lapses at, or null for "until I say
  // so", so an expired date reads as unpaused without anyone running a job.
  'emailPaused', 'emailPausedUntil',
  // Quiet hours — the sender drops non-essential mail inside this window.
  // Times are "HH:MM" on the account's own clock (appearance timezone).
  'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd',
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
    // A quiet window the clock math cannot read would either silently never
    // suppress or silently always suppress — so it is a strict "HH:MM" or no.
    if (data.quietHoursEnabled !== undefined && typeof data.quietHoursEnabled !== 'boolean') {
      return NextResponse.json({ error: 'Invalid quietHoursEnabled' }, { status: 400 });
    }
    for (const key of ['quietHoursStart', 'quietHoursEnd'] as const) {
      if (data[key] !== undefined
          && !(typeof data[key] === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(data[key]))) {
        return NextResponse.json({ error: `Invalid ${key}` }, { status: 400 });
      }
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

    let clearUnsub: Record<string, any> | null = null;
    if (data.email === true) {
      const row = await prisma.userPreferences.findUnique({ where: { userId: session.userId }, select: { notif: true } });
      const notif: any = (row?.notif && typeof row.notif === 'object' && !Array.isArray(row.notif)) ? row.notif : {};
      const eu: any = (notif.unsubscribed && typeof notif.unsubscribed === 'object' && !Array.isArray(notif.unsubscribed)) ? notif.unsubscribed : {};
      if (eu.all || eu.product || eu.forms || eu.support) {
        clearUnsub = { ...eu, all: false, product: false, forms: false, support: false };
      }
    }

    await saveNotificationPrefs(session.userId, clearUnsub ? { ...data, unsubscribed: clearUnsub } : data);

    if (clearUnsub) {
      console.log(`[NOTIFICATIONS] Cleared emailUnsub flags for user ${session.userId} (email re-enabled)`);
    }

    // Answer with the same merged view a GET gives — the raw save result is
    // the stored column, which lacks the view-only fields (the account's
    // timezone) the quiet-hours copy on the screen reads.
    return NextResponse.json(await loadNotificationPrefs(session.userId));
  } catch (err: any) {
    console.error('[NOTIFICATIONS] Update prefs error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 });
  }
}
