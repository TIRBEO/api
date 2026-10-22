import { prisma } from '@/infrastructure/db/prisma';
import type { Prisma } from '@prisma/client';
import { sendTemplateEmail, escapeHtml } from '@/features/email/email';
import { sendToUserWs } from '@/infrastructure/realtime/ws-deliver';
import { isInQuietHours } from '@/features/email/emailPrefs';
import { cardItem } from '@/features/email/email-fragments';
import { tirbeoEmailFor } from '@/features/identity/tirbeo';

export type NotifType = 'security' | 'system' | 'digest' | 'admin_alert' | 'login' | 'forms' | 'product' | 'support' | 'ticket' | 'tips' | 'tip' | 'offers';

/** Which preference category a notification type belongs to. Security/login are always compulsory. */
export type NotifCategory = 'security' | 'forms' | 'product' | 'support' | 'tips' | 'offers';

const CATEGORY_BY_TYPE: Record<string, NotifCategory> = {
  security: 'security',
  login: 'security',
  forms: 'forms',
  product: 'product',
  support: 'support',
  ticket: 'support',
  system: 'product',
  digest: 'product',
  admin_alert: 'product',
  // Campaign mail — offers, promotions, "come back" notes. They answer to the
  // page's own "Offers and promotions" switch (offersEmail), not to product.
  marketing: 'offers',
  offers: 'offers',
  promotion: 'offers',
  reactivation: 'offers',
  tips: 'tips',
  tip: 'tips',
};

export function notifCategory(type: string): NotifCategory {
  return CATEGORY_BY_TYPE[type?.toLowerCase()] || 'product';
}

interface CreateNotifInput {
  userId: string;
  type: NotifType;
  title: string;
  body?: string;
  link?: string;
  icon?: string;
  /** Structured details (ip, device, method…) shown in the inbox detail view. */
  metadata?: Record<string, unknown>;
  /** When true, skip the dedicated email even if prefs allow it (use when caller sends a specific template). */
  skipEmail?: boolean;
  /** When true, skip push even if prefs allow it. */
  skipPush?: boolean;
}

const on = (v: boolean | null | undefined) => v !== false; // default ON

/** Human-readable device string from a raw user-agent, e.g. "Chrome on Windows". */
export function describeDevice(ua?: string | null): string {
  if (!ua) return 'an unknown device';
  const browser = /edg\//i.test(ua) ? 'Edge'
    : /opr\/|opera/i.test(ua) ? 'Opera'
    : /chrome|crios/i.test(ua) ? 'Chrome'
    : /firefox|fxios/i.test(ua) ? 'Firefox'
    : /safari/i.test(ua) ? 'Safari'
    : 'Browser';
  const os = /windows/i.test(ua) ? 'Windows'
    : /android/i.test(ua) ? 'Android'
    : /iphone|ipad|ipod/i.test(ua) ? 'iOS'
    : /mac os x|macintosh/i.test(ua) ? 'macOS'
    : /linux/i.test(ua) ? 'Linux'
    : 'Unknown OS';
  return `${browser} on ${os}`;
}

export function getClientIpFromRequest(request: { headers: Headers }): string {
  const xff = request.headers.get('x-forwarded-for') || '';
  const ip = xff.split(',')[0].trim() || request.headers.get('x-real-ip') || '';
  if (ip) return ip;
  try { return request.headers.get('cf-connecting-ip') || ''; } catch { return ''; }
}

/** The user's best contact email: their Tirbeo identity when they have one,
 *  otherwise the primary/default row from user_email (mirrors the
 *  userEmailForSession pattern in features/auth/session.ts). */
export async function primaryEmailForUser(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } }).catch(() => null);
  if (user?.username) return tirbeoEmailFor(user.username);
  const row = await prisma.userEmail.findFirst({
    where: { userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { address: true },
  }).catch(() => null);
  return row?.address || null;
}

/** Per-user notification rate-limit: 10/min via Redis `notif:${userId}:` (Upstash). Falls back to allow if Redis unavailable. */
let _notifRedis: any = null;
let _notifRedisFailed = false;
async function getNotifRedis(): Promise<any | null> {
  if (_notifRedisFailed) return null;
  if (_notifRedis) return _notifRedis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    // Use the shared Redis factory which includes error handlers, keep-alive,
    // and reconnection logic — avoids unhandled 'error' events.
    const { getCachedRedisClient } = await import('@/infrastructure/db/redis');
    _notifRedis = getCachedRedisClient('notif-ratelimit', {
      url,
      enableKeepAlive: false, // short-lived rate-limit checks don't need keep-alive
    });
    return _notifRedis;
  } catch { _notifRedisFailed = true; return null; }
}
export async function checkNotifRateLimit(userId: string, limit = 10, windowSec = 60): Promise<{ allowed: boolean; remaining: number }> {
  return checkRateLimit(`notif:${userId}`, limit, windowSec);
}
export async function checkRateLimit(prefix: string, limit = 20, windowSec = 60): Promise<{ allowed: boolean; remaining: number }> {
  // Generic per-prefix rate-limit helper for UI feedback (e.g. prefs:${userId})
  const redis = await getNotifRedis();
  if (redis) {
    const key = `${prefix}:${Math.floor(Date.now() / (windowSec*1000))}`;
    try {
      // One queue, so a death between the two commands cannot leave a bucket
      // with no TTL — that counter would never roll over.
      const reply = await redis.multi().incr(key).pexpire(key, windowSec * 1000).exec();
      const count = Number(reply?.[0]?.[1]);
      if (reply?.[0]?.[0] || !Number.isFinite(count)) throw reply?.[0]?.[0] || new Error('bad INCR reply');
      return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
    } catch { /* Redis error → fall through to Postgres */ }
  }
  // Durable fixed window (was fail-open on no Redis). Guarded: if Postgres is
  // unreachable too we still allow, but only when BOTH stores are down.
  try {
    const { consumeWindow } = await import('@/features/auth/db-windows');
    const w = await consumeWindow(`notifwin:${prefix}`, limit, windowSec * 1000);
    return { allowed: w.allowed, remaining: Math.max(0, limit - w.count) };
  } catch {
    return { allowed: true, remaining: limit };
  }
}

// ─── createNotification ───
// STRICT PRIVACY: each notification row is bound to exactly one userId.
// No CC, no BCC, no broadcast — every channel (DB, WS, email, push) uses
// this same userId. Any attempt to create a notification without a valid
// target is rejected outright.
export async function createNotification(input: CreateNotifInput) {
  if (!input.userId || typeof input.userId !== 'string' || input.userId.trim().length < 8) {
    console.error('[NOTIFICATIONS] rejected: missing/invalid userId', input.title?.slice(0, 40));
    throw new Error('createNotification requires a valid userId');
  }
  const targetUserId = input.userId.trim();
  // Extra guard: ensure the target user actually exists (prevents orphan writes
  // and accidental leakage via typos).
  try {
    const exists = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!exists) {
      console.error('[NOTIFICATIONS] rejected: target user does not exist', targetUserId);
      throw new Error('Target user not found');
    }
  } catch (e: any) {
    if (e?.message === 'Target user not found') throw e;
    // DB check failed — fall through to allow write (fail-open for availability)
  }
  const category = notifCategory(input.type);

  // Load the preference the account actually holds — merged, so a choice made
  // on either side of the old split is seen here.
  let prefs: any = null;
  try {
    prefs = await loadNotificationPrefs(input.userId);
  } catch { /* fall through with defaults */ }

  // Security/login notifications are ALWAYS ON — compulsory, no user toggle.
  // In-app (DB + WebSocket) is always ON.
  // Email and push are configurable per category. EMAIL IS OPT-IN for
  // non-security categories: an unset toggle means NO email (in-app + push
  // still work). This prevents every notification emailing every user.
  /* The channel toggle is the whole decision, because it is the switch the
     settings screen actually has and actually writes ("Product updates" off the
     account's notifications page). The older per-category master is nobody's
     decision any more — no screen sets it, and its stored default is off — so
     requiring it alongside the channel made the switch on the screen do
     nothing. The mail path (emailPrefs.shouldSuppressEmail) reads the channel
     the same way, which is what keeps the two gates from disagreeing. */
  const isSecurity = category === 'security';
  const isTips = category === 'tips';
  const emailOn = isSecurity || (isTips
    ? (prefs?.email !== false && prefs?.tipsEmail === true)
    : (prefs?.email !== false && prefs?.[`${category}Email`] === true));
  const pushOn = isSecurity || (isTips
    ? (on(prefs?.push) && (prefs?.tipsPush !== undefined ? on(prefs.tipsPush) : on(prefs?.productPush)))
    : (on(prefs?.push) && on(prefs?.[`${category}Push`])));

  // Per-user rate-limit 10/min for non-security — prevents ticket loops / spam
  if (!isSecurity) {
    const { allowed } = await checkNotifRateLimit(targetUserId, 10, 60);
    if (!allowed) {
      console.warn(`[NOTIFICATIONS] rate-limited notif:${targetUserId} type=${input.type} title="${input.title.slice(0,40)}"`);
      return null as any;
    }
  }

  // The consolidated Notification model dropped the `icon` column — fold it
  // into `metadata` so the inbox/push payloads keep carrying it.
  const metadata: Record<string, unknown> = { ...(input.metadata || {}) };
  if (input.icon) metadata.icon = input.icon;

  const notif = await prisma.notification.create({
    data: {
      userId: targetUserId,
      type: input.type,
      title: input.title,
      body: input.body || null,
      icon: input.icon || null,
      link: input.link || null,
      metadata: metadata as any,
    },
  });

  // Send real-time notification via WebSocket — ONLY to the target user's
  // private channel `user:${targetUserId}`. Never broadcast.
  const notifData = { id: notif.id, userId: notif.userId, type: notif.type, title: notif.title, body: notif.body, link: notif.link, icon: input.icon || null, read: !!notif.isRead, createdAt: notif.createdAt.toISOString() };
  await sendToUserWs(targetUserId, { type: 'notification', data: notifData });

  // Pusher Channels fan-out — same payload over `private-user-<id>` so tabs
  // connected via Pusher (accounts app) toast instantly too. Fire-and-forget;
  // failures are logged inside pusher-deliver and never affect the response.
  try {
    const { pusherNotifyUser } = await import('@/infrastructure/realtime/pusher-deliver');
    pusherNotifyUser(targetUserId, 'notification', notifData);
  } catch { /* pusher lib unavailable — ws delivery already sent */ }

  // Bust the notifications list cache so polling clients see it immediately.
  // Per-user only — never clear the global cache.
  try {
    const { bustNotificationsCache } = await import('@/features/users/userHandlers');
    bustNotificationsCache(targetUserId);
  } catch { /* non-fatal */ }

  // External channels (email / push) respect quiet hours (but NOT security).
  const effectiveEmailOn = emailOn && !input.skipEmail;
  const effectivePushOn = pushOn && !input.skipPush;
  if (!effectiveEmailOn && !effectivePushOn) return notif;
  if (!isSecurity) {
    const quiet = isInQuietHours(prefs);
    if (quiet) return notif;
  }

  // Push/email are best-effort and must NOT block the in-app response — fire-and-forget for per-user speed
  // All external channels are strictly single-recipient (targetUserId only).
  if (effectivePushOn) {
    // Beams web push (device interests — accounts app browsers). Delivered in
    // parallel with the existing VAPID push; each covers different clients.
    try {
      const { beamsNotifyUser } = await import('@/infrastructure/realtime/pusher-deliver');
      beamsNotifyUser(
        targetUserId,
        input.title,
        input.body || '',
        input.link || '/settings/notifications',
        input.icon || undefined,
      );
    } catch { /* beams not configured */ }

    void import('@/infrastructure/push/push-notifications').then(m=> m.sendPushNotification(targetUserId, {
      title: input.title, body: input.body || '', icon: input.icon || undefined, url: input.link || '/settings/notifications', tag: input.type,
    }).catch(()=>{})).catch(()=>{});
  }
// Per-notification mail is decided by the category toggles alone: the batched
// digest that used to suppress these is gone, replaced by the account recap.
    if (effectiveEmailOn && category !== 'product') {
      void (async () => {
        // Email/name moved off User: primary address lives in user_email,
        // display name in user_profile (see features/identity/tirbeo.ts).
        const user = await prisma.user.findUnique({
          where: { id: targetUserId },
          select: { profile: { select: { name: true } } },
        });
        if (!user) return;
        const email = await primaryEmailForUser(targetUserId);
        if (!email) return;
        const dash = await import('@/config/app-urls').then(mod => mod.getDashboardBaseUrl()).catch(() => 'https://tirbeo.com');
        const base = typeof dash === 'string' ? dash : 'https://tirbeo.com';
        // Relative links open on the dashboard's notifications page — the
        // link itself is usually a dashboard path (e.g. /support/tickets/x).
        const resolved = input.link
          ? (/^https?:\/\//i.test(input.link) ? input.link : `${base}${input.link}`)
          : `${base}/settings/notifications`;
        return sendTemplateEmail(email, 'notification_digest', {
          name: user.profile?.name || email, count: '1',
          digestItems: cardItem(escapeHtml(input.title), escapeHtml(input.body || '')),
          activitySection: '',
          dashboardUrl: resolved,
        }, { rawVars: ['digestItems', 'activitySection'], categoryOverride: category, userId: targetUserId,
             // The row metadata (caller event refs like { eventId }) rides into
             // email_jobs.payload so the admin send log is searchable by them.
             metadata: { ...(input.metadata || {}), notificationId: notif.id } }).catch(() => {});
      })().catch(() => {});
    }

  return notif;
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, isRead: { not: true } } });
}

export async function listNotifications(userId: string, limit = 50, offset = 0) {
  const [items, total] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.notification.count({ where: { userId } }),
  ]);
  return { items, total };
}

export async function markAsRead(userId: string, notifId?: string) {
  if (notifId) {
    await prisma.notification.updateMany({ where: { id: notifId, userId, isRead: { not: true } }, data: { isRead: true } });
  } else {
    await prisma.notification.updateMany({ where: { userId, isRead: { not: true } }, data: { isRead: true } });
  }
}

// ─── Default preferences ──────────────────────────────────────────
// Security is compulsory (no toggle). Only forms/product/support/tips have toggles.
// Single source of truth — app/api/notifications/prefs/route.ts and the
// per-section handlers in userHandlers.ts must stay in sync with this.
export const DEFAULT_PREFS: Record<string, unknown> = {
  email: true, push: true,
  // Category toggles — security is compulsory (always true, not configurable)
  forms: true, product: false, support: true, tips: true,
  // Per-category channel toggles — EMAIL IS OPT-IN (push stays on)
  formsEmail: false, formsPush: true,
  productEmail: false, productPush: true,
  supportEmail: false, supportPush: true,
  offers: true, offersEmail: false, offersPush: true,
  tipsEmail: false, tipsPush: false,
  // Pause everything: only codes and security alerts get through while set.
  // `emailPausedUntil` is the epoch ms it lapses at, or null for "until I say
  // so" — an expired date reads as unpaused without anyone having to run a job.
  emailPaused: false, emailPausedUntil: null,
  // Quiet hours: non-essential mail waits until the window closes. The gate
  // (emailPrefs.isInQuietHours) reads the account's own clock (appearance
  // timezone); off by default means mail flows until the person says otherwise.
  quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '08:00',
  // Periodic account recap — the only recurring mail. Its cadence is the
  // person's choice; the send clock is written by jobs/jobs.ts alone.
  summaryEnabled: false, summaryFrequency: 'weekly',
  // The legacy digest flag — stored on every account (it is the column
  // default's), read by the mail gate (emailPrefs.shouldSuppressEmail: a
  // digest-family send needs an explicit true). Off here means no digest mail
  // for anyone who never opted in, which is exactly what a default should say.
  digestEnabled: false, digestFrequency: 'daily',
};

/**
 * What a brand-new account is set to, written to `user_preferences.notif` at
 * signup.
 *
 * Left unsaid, the column's shipped JSON default would answer instead — a
 * literal that predates this file and turned category mail on. Neither the
 * person nor anyone else chose that; a default that reads as consent is how
 * somebody ends up mailed something they never asked for.
 */
export const NEW_ACCOUNT_PREFS: Record<string, any> = { ...DEFAULT_PREFS, security: true };

/**
 * The one place a notification preference is read, and the one place it is
 * written: `user_preferences.notif`.
 *
 * Two places used to hold this answer: `users.notification_preferences`, which
 * the settings screens committed to, and `user_preferences.notif`, which the
 * senders read. Nothing kept them in sync, so a person could turn mail off in
 * the app and still be mailed — the choice they made was simply not the one
 * that decided anything. The legacy column has since been dropped, so `notif`
 * is now the single store: it holds both what the interface edits and the
 * bookkeeping no person touches (when the last digest went out, which push
 * endpoints are registered).
 */
const asObj = (raw: unknown): Record<string, any> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {};

/**
 * Fields the server owns. Nobody edits them in the interface, and a settings
 * write must never carry a stale copy of one back over the live value: that
 * rewinds a send clock and mails someone twice for one period. The `notif`
 * store is the only place they are kept, and the digest sweep is the only
 * writer of them.
 */
const SERVER_OWNED_KEYS = ['lastSummarySentAt', 'lastDigestSentAt', 'lastWeeklySentAt'];

export async function loadNotificationPrefs(userId: string): Promise<Record<string, any>> {
  const prefs = await prisma.userPreferences.findUnique({
    where: { userId },
    select: { notif: true, appearance: true },
  });
  const notif = asObj(prefs?.notif);
  const appearance = asObj(prefs?.appearance);
  // The profile's timezone joins the view: quiet hours are the person's
  // clock, not the server's. View-only — no writer puts it back in notif.
  return {
    ...DEFAULT_PREFS,
    ...notif,
    ...(appearance.timezone ? { timezone: appearance.timezone } : {}),
  };
}

export async function saveNotificationPrefs(userId: string, patch: Record<string, unknown>): Promise<Record<string, any>> {
  // The whole notif column is rewritten on every save, so the read and the
  // write must not interleave with another writer's — two simultaneous
  // settings changes used to silently drop one of them. Serializable gives
  // Postgres the right to abort the loser; the retry makes it win on the
  // rerun instead.
  return serializedPrefsWrite(async (tx) => {
    const row = await tx.userPreferences.findUnique({ where: { userId }, select: { notif: true } });
    const current = asObj(row?.notif);
    const merged = { ...DEFAULT_PREFS, ...current, ...patch };
    const chosen: Record<string, unknown> = { ...merged };
    for (const key of SERVER_OWNED_KEYS) delete chosen[key];
    // Keep the machine-owned bookkeeping fields living in notif.
    const nextNotif: Record<string, any> = { ...current };
    for (const key of SERVER_OWNED_KEYS) if (key in current) nextNotif[key] = current[key];
    Object.assign(nextNotif, chosen);
    await tx.userPreferences.upsert({
      where: { userId },
      create: { userId, notif: nextNotif as any },
      update: { notif: nextNotif as any },
    });
    return { ...nextNotif };
  });
}

/**
 * One read-modify-write pass over `user_preferences` at Serializable isolation,
 * retried when Postgres aborts the loser of an overlap. Both bag writers
 * (notif prefs and the misc.settings bag) go through this so two settings
 * changes on one account can never each overwrite the other's column wholesale.
 */
export async function serializedPrefsWrite<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: 'Serializable' });
    } catch (err: any) {
      const code = err?.code ?? err?.cause?.code;
      if (code === '40001' || code === 'P2034') { lastErr = err; continue; }
      throw err;
    }
  }
  throw lastErr;
}

/** Read a user's notification preferences. */
export async function getOrCreatePrefs(userId: string): Promise<Record<string, any>> {
  return loadNotificationPrefs(userId);
}

/** Merge-update the user's notification prefs. */
export async function updatePrefs(userId: string, data: Record<string, unknown>): Promise<Record<string, any>> {
  return saveNotificationPrefs(userId, data);
}
