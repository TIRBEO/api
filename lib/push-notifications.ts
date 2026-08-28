// ═══ PUSH NOTIFICATIONS (Web Push / VAPID) — DB-backed with in-memory fallback ═══
const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@tirbeo.app';

let configured = false;
if (PUBLIC_KEY && PRIVATE_KEY) {
  try {
    const webpush = require('web-push');
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    configured = true;
  } catch (err) {
    console.error('[PUSH] Failed to configure web-push:', (err as any)?.message);
  }
} else {
  console.warn('[PUSH] VAPID keys missing — push disabled. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY');
}

// In-memory fallback if DB is unavailable (dev / migration pending)
const memByEndpoint = new Map<string, { id: string; userId: string; endpoint: string; p256dh: string; auth: string; userAgent: string | null; createdAt: Date; lastUsedAt: Date }>();
let memNextId = 1;
function memMakeId() { return `push_${memNextId++}_${Date.now()}`; }

export function isPushConfigured(): boolean { return configured; }
export function getVapidPublicKey(): string | null { return configured ? PUBLIC_KEY : null; }

async function getPrisma() {
  try { const { prisma } = await import('./db/prisma'); return prisma; } catch { return null; }
}

export async function getUserPushSubscriptions(userId: string) {
  const prisma = await getPrisma();
  if (prisma && (prisma as any).pushSubscription) {
    try {
      const rows = await (prisma as any).pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
      return rows.map((r: any) => ({ id: r.id, userId: r.userId, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, userAgent: r.userAgent, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }));
    } catch (e: any) {
      if (!e.message?.includes('does not exist')) console.error('[PUSH] DB read failed, falling back to memory:', e.message);
    }
  }
  // Fallback: in-memory
  const out: typeof memByEndpoint extends Map<any, infer V> ? V[] : never = [] as any;
  for (const v of memByEndpoint.values()) if (v.userId === userId) out.push(v);
  return (out as any).sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function subscribeToPush(userId: string, subscription: { endpoint: string; p256dh: string; auth: string }, userAgent?: string) {
  if (!subscription.endpoint || !subscription.p256dh || !subscription.auth) throw new Error('Missing subscription keys');

  // Consent gate: check if user has opted into push notifications
  try {
    const { hasConsent } = await import('./consent');
    const pushAllowed = await hasConsent(userId, 'analytics');
    if (!pushAllowed) {
      console.log(`[PUSH] Subscription blocked — user ${userId} has not consented to push notifications`);
      throw new Error('Push notifications not enabled in your privacy settings');
    }
  } catch (err: any) {
    // Re-throw consent errors, ignore import errors
    if (err?.message?.includes('not enabled')) throw err;
  }
  const prisma = await getPrisma();
  if (prisma && (prisma as any).pushSubscription) {
    try {
      const rec = await (prisma as any).pushSubscription.upsert({
        where: { endpoint: subscription.endpoint },
        update: { userId, p256dh: subscription.p256dh, auth: subscription.auth, userAgent: userAgent || null, lastUsedAt: new Date() },
        create: { userId, endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth, userAgent: userAgent || null },
      });
      return { id: rec.id };
    } catch (e: any) {
      console.error('[PUSH] DB upsert failed, using memory:', e.message);
    }
  }
  const now = new Date();
  const existing = memByEndpoint.get(subscription.endpoint);
  if (existing) {
    existing.userId = userId; existing.p256dh = subscription.p256dh; existing.auth = subscription.auth; existing.userAgent = userAgent || null; existing.lastUsedAt = now;
    return { id: existing.id };
  }
  const id = memMakeId();
  memByEndpoint.set(subscription.endpoint, { id, userId, endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth, userAgent: userAgent || null, createdAt: now, lastUsedAt: now });
  return { id };
}

export async function unsubscribeFromPush(userId: string, endpoint: string) {
  const prisma = await getPrisma();
  if (prisma && (prisma as any).pushSubscription) {
    try { await (prisma as any).pushSubscription.deleteMany({ where: { userId, endpoint } }); } catch {}
  }
  const mem = memByEndpoint.get(endpoint);
  if (mem && mem.userId === userId) memByEndpoint.delete(endpoint);
  return { ok: true };
}

export async function sendPushNotification(userIdOrSubscription: string | { endpoint: string; p256dh: string; auth: string }, payload?: { title: string; body?: string; icon?: string; url?: string; tag?: string }): Promise<{ sent: number; failed: number }> {
  if (!configured) return { sent: 0, failed: 0 };
  let subs: { endpoint: string; p256dh: string; auth: string; id?: string }[];
  if (typeof userIdOrSubscription === 'string') {
    // Consent gate: check if user has opted into push notifications
    try {
      const { hasConsent } = await import('./consent');
      const pushAllowed = await hasConsent(userIdOrSubscription, 'analytics');
      if (!pushAllowed) {
        console.log(`[PUSH] Send blocked — user ${userIdOrSubscription} has not consented to push notifications`);
        return { sent: 0, failed: 0 };
      }
    } catch {}
    subs = (await getUserPushSubscriptions(userIdOrSubscription)).map((s: { id: string; endpoint: string; p256dh: string; auth: string }) => ({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, id: s.id }));
  } else {
    subs = [userIdOrSubscription];
  }
  if (subs.length === 0) return { sent: 0, failed: 0 };
  const webpush = require('web-push');
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({
        title: payload?.title || 'Tirbeo',
        body: payload?.body || '',
        icon: payload?.icon || '/icons/notification.png',
        badge: '/icons/badge.png',
        url: payload?.url || '/account/inbox',
        tag: payload?.tag || 'tirbeo-notification',
        timestamp: Date.now(),
      }), { TTL: 3600 });
      sent++;
      // Update lastUsedAt in DB or memory
      const prisma = await getPrisma();
      if (prisma && (prisma as any).pushSubscription && sub.id) {
        try { await (prisma as any).pushSubscription.update({ where: { id: sub.id }, data: { lastUsedAt: new Date() } }); } catch {}
      } else {
        const mem = memByEndpoint.get(sub.endpoint);
        if (mem) mem.lastUsedAt = new Date();
      }
    } catch (err: any) {
      failed++;
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        // Prune stale endpoint
        const prisma = await getPrisma();
        if (prisma && (prisma as any).pushSubscription) try { await (prisma as any).pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } }); } catch {}
        memByEndpoint.delete(sub.endpoint);
      } else {
        console.warn('[PUSH] send failed:', err?.message || err);
      }
    }
  }));
  return { sent, failed };
}

/** Nightly prune: delete push subscriptions not used in 60 days. Runs hourly check + daily Vercel cron. */
export async function pruneStalePushSubscriptions(maxAgeDays = 60): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000);
  let deleted = 0;
  const prisma = await getPrisma();
  if (prisma && (prisma as any).pushSubscription) {
    try {
      const res = await (prisma as any).pushSubscription.deleteMany({ where: { lastUsedAt: { lt: cutoff } } });
      deleted += res.count || 0;
    } catch (e: any) {
      console.error('[PUSH] prune DB failed:', e.message);
    }
  }
  for (const [ep, rec] of Array.from(memByEndpoint.entries())) {
    if (rec.lastUsedAt < cutoff) { memByEndpoint.delete(ep); deleted++; }
  }
  if (deleted > 0) console.log(`[PUSH] pruned ${deleted} stale push subscriptions (> ${maxAgeDays}d)`);
  return deleted;
}
