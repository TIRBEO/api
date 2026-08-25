import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { prisma } from '@/lib/db/prisma';

export const runtime = 'nodejs';

// Preferences live directly on users.notification_preferences (jsonb).
const ALLOWED_FIELDS = [
  'type',
  // Global channels
  'email', 'push',
  // Category toggles
  'security', 'forms', 'product', 'support',
  // Per-category x channel matrix
  'securityEmail', 'securityPush',
  'formsEmail', 'formsPush',
  'productEmail', 'productPush',
  'supportEmail', 'supportPush',
  // Quiet hours
  'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd',
  // Digest & email summaries
  'digestEnabled', 'digestFrequency',
  'productEmail', 'weeklySummary',
] as const;

const DEFAULT_PREFS: Record<string, unknown> = {
  type: null,
  email: true, push: true,
  security: true, forms: true, product: true, support: true,
  securityEmail: true, securityPush: true,
  formsEmail: true, formsPush: true,
  productEmail: true, productPush: true,
  supportEmail: true, supportPush: true,
  quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '08:00',
  digestEnabled: false, digestFrequency: 'daily', weeklySummary: false,
};

const DIGEST_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    for (const t of ['quietHoursStart', 'quietHoursEnd']) {
      if (data[t] !== undefined && !TIME_RE.test(String(data[t]))) {
        return NextResponse.json({ error: `Invalid ${t} (HH:mm expected)` }, { status: 400 });
      }
    }

    const prefs = await loadPrefs(session.userId);
    Object.assign(prefs, data);
    await savePrefs(session.userId, prefs);

    return NextResponse.json(prefs);
  } catch (err: any) {
    console.error('[NOTIFICATIONS] Update prefs error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 });
  }
}
