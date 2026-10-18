import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { createTtlCache } from '@/infrastructure/cache';
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

  // The stored answer changed, so the read cache must change with it — a
  // person switching analytics OFF has to be OFF for their next event, not
  // one minute later.
  consentCache.delete(userId);

  return { prefs: next, rejected };
}

/** Also refuses unknown keys at the edge — silently dropping a toggle the
    client thought it saved is the lie this whole file exists to stop. */
export function unknownDataUsageKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((k) => !(KEYS as string[]).includes(k));
}

/* ─── The one consumer of `analyticsCookies`, server-side ───────────
   Client telemetry lands in activity_events through POST /api/telemetry/event.
   Behaviour-measuring categories are the ones the consent actually governs;
   operational events (an error the UI swallowed, a security signal) are not
   "analytics" and staying blind to them would be the service's problem, not
   the person's.

   Three rules:
   • Absent consent = allow. An account that has never been asked keeps
     reporting exactly what it reports today; nothing dies silently.
   • The answer is read from the account, never from the request. A client
     that sends its own `consent` flag is describing itself, not consenting.
   • A failed read allows. A hiccup must not become mass data loss.      */

/** Kinds that keep the service running: errors, security, delivery. */
const OPERATIONAL_EVENT_PREFIXES = [
  'client_error', 'error', 'security', 'captcha', 'network', 'job', 'crash', 'warning',
];

/** Kinds that measure behaviour — analytics, and the marketing data that rides
    on it (marketingCookies off is implied by analyticsCookies off). */
const ANALYTICS_EVENT_PREFIXES = [
  'ui.', 'page.', 'docs.', 'view', 'click', 'impression', 'perf', 'web-vital',
  'funnel.', 'marketing.', 'ads.', 'analytics.', 'experiment.', 'feature.',
  'signup.', 'auth.signup_start', 'auth.login_submit', 'auth.otp_sent',
  'auth.otp_verified', 'auth.passkey_login', 'auth.2fa_submit', 'auth.login_success',
  'auth.signup_success',
];

/** Whether a client event kind belongs to an analytics/cookie-dependent
    category. Unknown kinds are NOT treated as analytics: the classifier must
    never be the thing that switches off a production signal by not knowing it. */
export function isAnalyticsCategoryEvent(kind: string): boolean {
  const k = (kind || '').toLowerCase();
  if (!k) return false;
  if (OPERATIONAL_EVENT_PREFIXES.some((p) => k.startsWith(p))) return false;
  return ANALYTICS_EVENT_PREFIXES.some((p) => k.startsWith(p));
}

/** The account's stored answer for analytics cookies; true when there is no
    account, no stored answer, or no read.
    Cached briefly because the telemetry ingest hits this on every client event
    — a per-event DB round-trip would make consent the most expensive query in
    the app. The write below clears the entry, so turning cookies OFF takes
    effect on the account that just did it immediately. */
const consentCache = createTtlCache<boolean>(60_000, 5000, 'analyticsConsent');

export async function analyticsConsentAllowed(userId?: string | null): Promise<boolean> {
  if (!userId) return true;
  const cached = consentCache.get(userId);
  if (cached !== undefined) return cached;
  try {
    const prefs = await loadDataUsagePrefs(userId);
    const allowed = prefs.analyticsCookies !== false;
    consentCache.set(userId, allowed);
    return allowed;
  } catch {
    return true;
  }
}

/** The consent answers are the account's, stored in privacy. A client that
    posts a `consent`-shaped field into an event's metadata would otherwise
    write a fake answer into the same ledger admins read — drop those keys. */
const CLIENT_CONSENT_KEYS = ['consent', 'analyticsCookies', 'marketingCookies', 'dataUsage', 'hasConsent'];
export function stripClientConsentFields(metadata: Record<string, unknown>): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (CLIENT_CONSENT_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
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
