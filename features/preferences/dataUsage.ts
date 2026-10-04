import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { jsonUnauthorized } from '@/shared/response';

/* ═══════════════════════════════════════════════════════════════════
   Data usage and cookie choices — saved, not just displayed.

   The four toggles on the settings screen used to live in this browser's
   localStorage (via the generic settings bag, whose writes never reached
   the account at all). They now live on the account, in ONE place:
   `preferences.user_preferences.privacy.dataUsage`, a named object in the
   privacy blob — the same blob that already holds allowAnalytics, and
   deliberately keyed apart from it so the two answers can't overwrite
   each other.

   These are not notification preferences: nothing on the send clock reads
   them, so they do not belong in the loadNotificationPrefs blob. They are
   data-use consents, so they belong in privacy — and `loadDataUsagePrefs`
   / `saveDataUsagePrefs` are the only reader and writer. The admin panel
   that *analyses* this data does not exist yet; when it does, it reads
   through `loadDataUsagePrefs` too, and the answer the person gave is the
   answer it finds.

   One invariant is enforced here, not on the screen: marketing cookies are
   measured from analytics data, so analytics off ⇒ marketing off. A rule
   only the UI knows is a rule one curl call breaks.
   ═══════════════════════════════════════════════════════════════════ */

export type DataUsagePrefs = {
  personalised: boolean;
  shareWithPartners: boolean;
  analyticsCookies: boolean;
  marketingCookies: boolean;
};

/** What an account that has never been asked answers. */
export const DATA_USAGE_DEFAULTS: DataUsagePrefs = {
  personalised: true,
  shareWithPartners: false,
  analyticsCookies: true,
  marketingCookies: false,
};

const KEYS = Object.keys(DATA_USAGE_DEFAULTS) as (keyof DataUsagePrefs)[];

const asObj = (raw: unknown): Record<string, any> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {};

/** The one read. Only a real boolean counts as an answer; anything else in
    the blob falls back to the default rather than becoming junk the next
    write would carry forward. */
export async function loadDataUsagePrefs(userId: string): Promise<DataUsagePrefs> {
  const row = await prisma.userPreferences.findUnique({
    where: { userId },
    select: { privacy: true },
  });
  const stored = asObj(asObj(row?.privacy).dataUsage);
  const merged = { ...DATA_USAGE_DEFAULTS };
  for (const key of KEYS) {
    if (typeof stored[key] === 'boolean') merged[key] = stored[key];
  }
  return merged;
}

/**
 * The one write. Patches are filtered to the four known keys — an unknown
 * key is refused, not stored, so this blob can't accumulate whatever a
 * misclicked client sends. `privacy` is merged, never replaced: the
 * consent keys preferencesHandler owns keep their values.
 */
export async function saveDataUsagePrefs(
  userId: string,
  patch: Record<string, unknown>,
): Promise<{ prefs: DataUsagePrefs; rejected: string[] }> {
  const rejected: string[] = [];
  const current = await loadDataUsagePrefs(userId);
  const next = { ...current };
  for (const key of KEYS) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'boolean') {
      rejected.push(key);
      continue;
    }
    next[key] = patch[key] as boolean;
  }
  // A write is all-or-nothing: when anything in the patch was refused, the
  // stored answers stay exactly as they were — no half-applied consent, and
  // no junk request materialising a row for an account that never chose.
  if (rejected.length > 0) return { prefs: current, rejected };

  // The dependency, enforced server-side: marketing rides on analytics data.
  if (next.analyticsCookies === false) next.marketingCookies = false;

  const row = await prisma.userPreferences.findUnique({
    where: { userId },
    select: { privacy: true },
  });
  const privacy = { ...asObj(row?.privacy), dataUsage: next };
  await prisma.userPreferences.upsert({
    where: { userId },
    create: { userId, privacy: privacy as any },
    update: { privacy: privacy as any },
  });

  return { prefs: next, rejected };
}

/** Also refuses unknown keys at the edge — silently dropping a toggle the
    client thought it saved is the lie this whole file exists to stop. */
export function unknownDataUsageKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((k) => !(KEYS as string[]).includes(k));
}

// ─── HTTP edge ─────────────────────────────────────────────────────

/** GET /api/preferences/data-usage — the account's stored answers (defaults
    for whatever it has never set). PUT with a patch — writes and answers
    with the FULL merged set, so the screen settles on the stored truth. */
export async function dataUsageHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    if (request.method === 'GET') {
      return NextResponse.json({ ok: true, ...(await loadDataUsagePrefs(session.userId)) });
    }

    if (request.method === 'PUT' || request.method === 'PATCH') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const stray = unknownDataUsageKeys(body);
      if (stray.length > 0) {
        return NextResponse.json(
          { error: `Unknown setting${stray.length > 1 ? 's' : ''}: ${stray.join(', ')}` },
          { status: 400 },
        );
      }
      const { prefs, rejected } = await saveDataUsagePrefs(session.userId, body);
      if (rejected.length > 0) {
        return NextResponse.json({ error: `Not a yes/no value: ${rejected.join(', ')}` }, { status: 400 });
      }
      return NextResponse.json({ ok: true, ...prefs });
    }

    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[DATA_USAGE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to process data usage request' }, { status: 500 });
  }
}
