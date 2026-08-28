import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';
import { checkRateLimit } from '@/lib/notifications';

export const runtime = 'nodejs';

// Preferences live directly on users.notification_preferences (jsonb).
// Security is compulsory — no toggle for it.
const ALLOWED_FIELDS = [
  // Global channels
  'email', 'push',
  // Category toggles (forms, product, support only — security is compulsory)
  'forms', 'product', 'support',
  // Per-category x channel matrix
  'formsEmail', 'formsPush',
  'productEmail', 'productPush',
  'supportEmail', 'supportPush',
  // Digest
  'digestEnabled', 'digestFrequency',
] as const;

const DEFAULT_PREFS: Record<string, unknown> = {
  email: true, push: true,
  forms: true, product: false, support: true,
  formsEmail: true, formsPush: true,
  productEmail: false, productPush: true,
  supportEmail: true, supportPush: true,
  digestEnabled: false, digestFrequency: 'daily',
};

const DIGEST_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);

function readPrefs(raw: unknown): Record<string, any> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...DEFAULT_PREFS, ...(raw as object) } : { ...DEFAULT_PREFS };
}

async function loadPrefs(userId: string): Promise<Record<string, any>> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPreferences: true },
  });
  return readPrefs((user as any)?.notificationPreferences);
}

async function savePrefs(userId: string, prefs: Record<string, any>) {
  await prisma.$executeRaw`
    UPDATE "users" SET "notification_preferences" = ${JSON.stringify(prefs)}::jsonb
    WHERE "id" = ${userId}`;
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) return session;
    return NextResponse.json(await loadPrefs(session.userId));
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

    if (data.digestFrequency !== undefined && !DIGEST_FREQUENCIES.has(data.digestFrequency)) {
      return NextResponse.json({ error: 'Invalid digestFrequency' }, { status: 400 });
    }

    const prefs = await loadPrefs(session.userId);
    Object.assign(prefs, data);
    await savePrefs(session.userId, prefs);

    // If the user re-enabled email globally, clear the emailUnsub flags
    // AND re-enable all category email toggles that were disabled by the global unsubscribe.
    if (data.email === true) {
      // Re-enable category email toggles (formsEmail, productEmail, supportEmail)
      // so the user gets all emails back after re-subscribing.
      if (data.formsEmail === undefined) data.formsEmail = true;
      if (data.productEmail === undefined) data.productEmail = true;
      if (data.supportEmail === undefined) data.supportEmail = true;
      try {
        const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { emailUnsubscribed: true } });
        const eu: any = (user as any)?.emailUnsubscribed || {};
        if (eu.all || eu.product || eu.forms || eu.support) {
          eu.all = false;
          eu.product = false;
          eu.forms = false;
          eu.support = false;
          await prisma.$executeRaw`
            UPDATE "users" SET "email_unsubscribed" = ${JSON.stringify(eu)}::jsonb
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
