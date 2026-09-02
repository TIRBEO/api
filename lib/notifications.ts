import { prisma } from './db/prisma';
import { sendTemplateEmail, escapeHtml } from './email';

// WebSocket send - dynamically import to avoid circular deps and work in serverless
async function sendToUserWs(userId: string, data: unknown) {
  try {
    const { sendToUser } = await import('./ws/server');
    sendToUser(userId, data);
  } catch {
    // WS server not available (serverless or not started)
  }
}

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

/**
 * Check if the current time is within the user's quiet hours window.
 * Quiet hours suppress email and push notifications but NOT the DB record
 * or real-time WebSocket delivery — the user just won't get external alerts.
 */
async function isInQuietHours(prefs: { quietHoursEnabled?: boolean | null; quietHoursStart?: string | null; quietHoursEnd?: string | null } | null): Promise<boolean> {
  try {
    if (!prefs?.quietHoursEnabled) return false;

    const now = new Date();
    const startStr = prefs.quietHoursStart || '22:00';
    const endStr = prefs.quietHoursEnd || '08:00';

    const [startH, startM] = startStr.split(':').map(Number);
    const [endH, endM] = endStr.split(':').map(Number);

    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } catch {
    return false;
  }
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
let _notifRedisErrorLogged = false;
async function getNotifRedis(): Promise<any | null> {
  if (_notifRedisFailed) return null;
  if (_notifRedis) return _notifRedis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    // Use the shared Redis factory which includes error handlers, keep-alive,
    // and reconnection logic — avoids unhandled 'error' events.
    const { getCachedRedisClient } = await import('./db/redis');
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

/** Consistent timestamp for notification bodies, e.g. "Aug 24, 2026, 2:05 PM UTC". */
export function fmtNow(): string {
  return new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

export async function createNotification(input: CreateNotifInput) {
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
  // Email and push are configurable per category.
  // Tips has dedicated toggle (tips / tipsEmail) falling back to product toggles for backwards compat.
  const isSecurity = category === 'security';
  const isTips = category === 'tips';
  const emailOn = isSecurity || (isTips
    ? (on(prefs?.email) && (prefs?.tipsEmail !== undefined ? on(prefs.tipsEmail) : on(prefs?.productEmail)) && (prefs?.tips !== undefined ? on(prefs.tips) : on(prefs?.product)))
    : (on(prefs?.email) && on(prefs?.[`${category}Email`]) && on(prefs?.[category])));
  const pushOn = isSecurity || (isTips
    ? (on(prefs?.push) && (prefs?.tipsPush !== undefined ? on(prefs.tipsPush) : on(prefs?.productPush)) && (prefs?.tips !== undefined ? on(prefs.tips) : on(prefs?.product)))
    : (on(prefs?.push) && on(prefs?.[`${category}Push`]) && on(prefs?.[category])));

  // Per-user rate-limit 10/min for non-security — prevents ticket loops / spam
  if (!isSecurity) {
    const { allowed } = await checkNotifRateLimit(input.userId, 10, 60);
    if (!allowed) {
      console.warn(`[NOTIFICATIONS] rate-limited notif:${input.userId} type=${input.type} title="${input.title.slice(0,40)}"`);
      return null as any;
    }
  }

  const notif = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body || null,
      link: input.link || null,
      icon: input.icon || null,
      metadata: (input.metadata || {}) as any,
    },
  });

  // Send real-time notification via WebSocket (always — even during quiet hours)
  const notifData = { id: notif.id, userId: notif.userId, type: notif.type, title: notif.title, body: notif.body, link: notif.link, icon: notif.icon, read: false, createdAt: notif.createdAt.toISOString() };
  await sendToUserWs(input.userId, { type: 'notification', data: notifData });

  // Bust the notifications list cache so polling clients see it immediately.
  try {
    const { bustNotificationsCache } = await import('./userHandlers');
    bustNotificationsCache(input.userId);
  } catch { /* non-fatal */ }

  // External channels (email / push) respect quiet hours (but NOT security).
  const effectiveEmailOn = emailOn && !input.skipEmail;
  const effectivePushOn = pushOn && !input.skipPush;
  if (!effectiveEmailOn && !effectivePushOn) return notif;
  if (!isSecurity) {
    const quiet = await isInQuietHours(prefs);
    if (quiet) return notif;
  }

  // Push/email are best-effort and must NOT block the in-app response — fire-and-forget for per-user speed
  if (effectivePushOn) {
    void import('./push-notifications').then(m=> m.sendPushNotification(input.userId, {
      title: input.title, body: input.body || '', icon: input.icon || undefined, url: input.link || '/account/inbox', tag: input.type,
    }).catch(()=>{})).catch(()=>{});
  }
  if (effectiveEmailOn && category !== 'product') {
    void prisma.user.findUnique({ where: { id: input.userId }, select: { email: true, name: true } }).then(user=>{
      if(!user) return;
      import('./app-urls').then(mod=> mod.getDashboardBaseUrl()).catch(()=> 'https://tirbeo.app').then(dash=>{
        const base = typeof dash === 'string' ? dash : 'https://tirbeo.app';
        return sendTemplateEmail(user.email, 'notification_digest', {
          name: user.name || user.email, count: '1',
          digestItems: `<div class="item"><strong>${escapeHtml(input.title)}</strong><br/>${escapeHtml(input.body || '')}</div>`,
          activitySection: '',
          dashboardUrl: input.link ? `${base}${input.link}` : base,
        }, { rawVars: ['digestItems', 'activitySection'] }).catch(()=>{});
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
// Keep in sync with app/api/notifications/prefs/route.ts DEFAULT_PREFS
const DEFAULT_PREFS: Record<string, unknown> = {
  email: true, push: true,
  // Category toggles — security is compulsory (always true, not configurable)
  forms: true, product: false, support: true, tips: true,
  // Per-category channel toggles
  formsEmail: true, formsPush: true,
  productEmail: false, productPush: true,
  supportEmail: true, supportPush: true,
  tipsEmail: true, tipsPush: false,
  // Digest
  digestEnabled: false, digestFrequency: 'daily',
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

// Send real-time notification to a specific user via WebSocket
export async function sendRealtimeNotification(userId: string, notification: {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  icon?: string;
  read?: boolean;
  createdAt: string;
}) {
  await sendToUserWs(userId, { type: 'notification', data: notification });
}

// Broadcast notification to all online users
export async function broadcastNotification(notification: {
  id: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  icon?: string;
  read?: boolean;
  createdAt: string;
}) {
  try {
    const { broadcast } = await import('./ws/server');
    broadcast({ type: 'notification', data: notification });
  } catch {
    // WS server not available
  }
}

// Get list of online user IDs
export async function getOnlineUsers(): Promise<string[]> {
  try {
    const { getOnlineUserIds } = await import('./ws/server');
    return getOnlineUserIds();
  } catch {
    return [];
  }
}
