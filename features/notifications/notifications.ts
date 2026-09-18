import { prisma } from '@/infrastructure/db/prisma';
import { sendTemplateEmail, escapeHtml } from '@/features/email/email';
import { sendToUserWs } from '@/infrastructure/realtime/ws-deliver';
import { isInQuietHours } from '@/features/email/emailPrefs';

export type NotifType = 'security' | 'system' | 'digest' | 'admin_alert' | 'login' | 'forms' | 'product' | 'support' | 'ticket' | 'tips' | 'tip';

/** Which preference category a notification type belongs to. Security/login are always compulsory. */
export type NotifCategory = 'security' | 'forms' | 'product' | 'support' | 'tips';

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
  marketing: 'product',
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
  if (!redis) return { allowed: true, remaining: limit };
  const key = `${prefix}:${Math.floor(Date.now() / (windowSec*1000))}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  } catch { return { allowed: true, remaining: limit }; }
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

  // Load preferences from the user jsonb column (defaults all-on).
  let prefs: any = null;
  try {
    const u = await prisma.user.findUnique({ where: { id: input.userId }, select: { notificationPreferences: true } });
    prefs = (u as any)?.notificationPreferences;
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = null;
  } catch { /* fall through with defaults */ }

  // Security/login notifications are ALWAYS ON — compulsory, no user toggle.
  // In-app (DB + WebSocket) is always ON.
  // Email and push are configurable per category. EMAIL IS OPT-IN for
  // non-security categories: an unset toggle means NO email (in-app + push
  // still work). This prevents every notification emailing every user.
  // Tips has dedicated toggle (tips / tipsEmail) falling back to product toggles for backwards compat.
  const isSecurity = category === 'security';
  const isTips = category === 'tips';
  const emailOn = isSecurity || (isTips
    ? (prefs?.email !== false && prefs?.tipsEmail === true && (prefs?.tips !== undefined ? on(prefs.tips) : on(prefs?.product)))
    : (prefs?.email !== false && prefs?.[`${category}Email`] === true && on(prefs?.[category])));
  const pushOn = isSecurity || (isTips
    ? (on(prefs?.push) && (prefs?.tipsPush !== undefined ? on(prefs.tipsPush) : on(prefs?.productPush)) && (prefs?.tips !== undefined ? on(prefs.tips) : on(prefs?.product)))
    : (on(prefs?.push) && on(prefs?.[`${category}Push`]) && on(prefs?.[category])));

  // Per-user rate-limit 10/min for non-security — prevents ticket loops / spam
  if (!isSecurity) {
    const { allowed } = await checkNotifRateLimit(targetUserId, 10, 60);
    if (!allowed) {
      console.warn(`[NOTIFICATIONS] rate-limited notif:${targetUserId} type=${input.type} title="${input.title.slice(0,40)}"`);
      return null as any;
    }
  }

  const notif = await prisma.notification.create({
    data: {
      userId: targetUserId,
      type: input.type,
      title: input.title,
      body: input.body || null,
      link: input.link || null,
      icon: input.icon || null,
      metadata: (input.metadata || {}) as any,
    },
  });

  // Send real-time notification via WebSocket — ONLY to the target user's
  // private channel `user:${targetUserId}`. Never broadcast.
  const notifData = { id: notif.id, userId: notif.userId, type: notif.type, title: notif.title, body: notif.body, link: notif.link, icon: notif.icon, read: false, createdAt: notif.createdAt.toISOString() };
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
        input.link || '/account/inbox',
        input.icon || undefined,
      );
    } catch { /* beams not configured */ }

    void import('@/infrastructure/push/push-notifications').then(m=> m.sendPushNotification(targetUserId, {
      title: input.title, body: input.body || '', icon: input.icon || undefined, url: input.link || '/account/inbox', tag: input.type,
    }).catch(()=>{})).catch(()=>{});
  }
// If digest is enabled, skip per-notification emails — the digest job batches them.
    const digestEnabled = prefs?.digestEnabled === true;
    if (effectiveEmailOn && category !== 'product' && !digestEnabled) {
      void prisma.user.findUnique({ where: { id: targetUserId }, select: { email: true, name: true } }).then(user=>{
        if(!user) return;
        import('@/config/app-urls').then(mod=> mod.getDashboardBaseUrl()).catch(()=> 'https://tirbeo.app').then(dash=>{
          const base = typeof dash === 'string' ? dash : 'https://tirbeo.app';
          return sendTemplateEmail(user.email, 'notification_digest', {
            name: user.name || user.email, count: '1',
            digestItems: `<div style="padding:12px 14px;background:#111111;border:1px solid rgba(245,245,245,0.13);border-radius:10px;margin-bottom:8px;"><strong style="color:#F5F5F5;font-size:14px;">${escapeHtml(input.title)}</strong><br/><span style="color:rgba(245,245,245,0.74);font-size:13px;">${escapeHtml(input.body || '')}</span></div>`,
            activitySection: '',
            dashboardUrl: input.link ? `${base}${input.link}` : base,
          }, { rawVars: ['digestItems', 'activitySection'], categoryOverride: category }).catch(()=>{});
        }).catch(()=>{});
      }).catch(()=>{});
    }

  return notif;
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, isRead: false } });
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
    await prisma.notification.updateMany({ where: { id: notifId, userId }, data: { isRead: true } });
  } else {
    await prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
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
  tipsEmail: false, tipsPush: false,
  // Digest
  digestEnabled: false, digestFrequency: 'daily',
  // Weekly activity summary (separate opt-in email, its own cadence)
  weeklySummary: false, weeklySummaryFrequency: 'weekly',
};

/** Read a user's notification preferences from their jsonb column. */
export async function getOrCreatePrefs(userId: string): Promise<Record<string, any>> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPreferences: true } });
  const raw = (user as any)?.notificationPreferences;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...DEFAULT_PREFS, ...raw } : { ...DEFAULT_PREFS };
}

/** Merge-update the user's notification_preferences jsonb. */
export async function updatePrefs(userId: string, data: Record<string, unknown>): Promise<Record<string, any>> {
  const prefs = await getOrCreatePrefs(userId);
  Object.assign(prefs, data);
  await prisma.$executeRaw`
    UPDATE "users" SET "notification_preferences" = ${JSON.stringify(prefs)}::jsonb
    WHERE "id" = ${userId}`;
  return prefs;
}
