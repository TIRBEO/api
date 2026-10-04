// ═══ TIRBEO SHARED — Pusher Channels (realtime) + Beams (web push) ═══
// Server-side publish library used by apps/api (and any other Node service).
//
// Realtime topology (mirrors accounts/src/lib/realtime.ts):
//   • 3× mt1 global pool apps — connections sharded per device
//   • ap2 (Mumbai) — South Asia
//   • ap4 (Singapore) — Asia-Pacific
//
// The server cannot know which regional app a client connected to (region is
// chosen client-side by timezone + persisted shard), so publishes FAN OUT to
// all configured apps. A connected client receives each event exactly once —
// it is only subscribed to one app.
//
// ALL credentials from env:
//   PUSHER_APP_ID_PRIMARY / PUSHER_KEY_PRIMARY / PUSHER_SECRET_PRIMARY / PUSHER_CLUSTER_PRIMARY
//   …SECONDARY / …TERTIARY / …AP2 / …AP4
//   BEAMS_INSTANCE_ID / BEAMS_PRIMARY_KEY

import crypto from 'crypto';

// ─── Env helpers ────────────────────────────────────────────────────────────

function env(name: string): string | undefined {
  return process.env[name];
}

export interface PusherAppConfig {
  name: string;
  appId: string;
  key: string;
  secret: string;
  cluster: string;
}

export const REGION_SUFFIXES = ['PRIMARY', 'SECONDARY', 'TERTIARY', 'AP2', 'AP4'] as const;

/** Read all fully-configured Channels apps from env. Empty array when none. */
export function getPusherApps(): PusherAppConfig[] {
  const apps: PusherAppConfig[] = [];
  for (const suffix of REGION_SUFFIXES) {
    const appId = env(`PUSHER_APP_ID_${suffix}`);
    const key = env(`PUSHER_KEY_${suffix}`);
    const secret = env(`PUSHER_SECRET_${suffix}`);
    const cluster = env(`PUSHER_CLUSTER_${suffix}`) || 'mt1';
    if (appId && key && secret) {
      apps.push({ name: suffix.toLowerCase(), appId, key, secret, cluster });
    }
  }
  return apps;
}

export function isPusherConfigured(): boolean {
  return getPusherApps().length > 0;
}

// ─── Channels REST trigger (HMAC-SHA256 signed, no SDK dependency) ─────────

/** Sign + POST to a Channels app's events endpoint. Returns true on 2xx. */
async function triggerOnApp(app: PusherAppConfig, body: string): Promise<boolean> {
  const md5 = crypto.createHash('md5').update(body).digest('hex');
  const qs = new URLSearchParams({
    auth_key: app.key,
    auth_timestamp: String(Math.floor(Date.now() / 1000)),
    auth_version: '1.0',
    body_md5: md5,
  }).toString();
  const toSign = `POST\n/apps/${app.appId}/events\n${qs}`;
  const sig = crypto.createHmac('sha256', app.secret).update(toSign).digest('hex');
  const url = `https://api-${app.cluster}.pusher.com/apps/${app.appId}/events?${qs}&auth_signature=${sig}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[PUSHER] ${app.name} trigger failed: ${res.status} ${(await res.text()).slice(0, 100)}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`[PUSHER] ${app.name} trigger error: ${err?.message || err}`);
    return false;
  }
}

export interface PusherTriggerOptions {
  /** Extra Channels apps by name (e.g. ['ap2']) — rarely needed; default is all. */
  regions?: string[];
}

export interface PusherTriggerResult {
  ok: number;
  failed: number;
  total: number;
}

/** Fan-out trigger on all (or selected) Channels apps. Never throws. */
export async function pusherTrigger(
  channel: string,
  event: string,
  data: unknown,
  opts: PusherTriggerOptions = {},
): Promise<PusherTriggerResult> {
  const apps = getPusherApps().filter((a) => !opts.regions || opts.regions.includes(a.name));
  if (apps.length === 0) return { ok: 0, failed: 0, total: 0 };

  const body = JSON.stringify({
    name: event,
    channel,
    data: JSON.stringify(data), // Channels requires data to be a JSON *string*
  });

  // Parallel fan-out, never throws
  const settled = await Promise.allSettled(apps.map((app) => triggerOnApp(app, body)));
  const ok = settled.filter((s) => s.status === 'fulfilled' && s.value).length;
  return { ok, failed: apps.length - ok, total: apps.length };
}

/** Publish a user-scoped event to `private-user-<id>` (all regions). */
export async function pusherSendToUser(
  userId: string,
  event: string,
  data: unknown,
): Promise<PusherTriggerResult> {
  return pusherTrigger(`private-user-${userId}`, event, data);
}

/** Publish a global announcement to the public `announcements` channel. */
export async function pusherAnnounce(message: string): Promise<PusherTriggerResult> {
  return pusherTrigger('announcements', 'announcement', { message });
}

// ─── Private-channel auth (for POST /api/pusher/auth) ──────────────────────

/**
 * Generate the Channels auth signature for a private/presence-channel
 * subscription. Used by the auth endpoint the pusher-js client calls when
 * subscribing to `private-*` channels. The API MUST verify the user's session
 * first and only authorize channels belonging to that user.
 *
 * Signature format per Pusher's auth spec:
 *   private-…  →  HMAC_SHA256(secret, `${socketId}:${channel}`)
 *   presence-… →  HMAC_SHA256(secret, `${socketId}:${channel}:${userDataJson}`)
 * userData is IGNORED for private channels — including it there produces an
 * invalid signature (Pusher validates exactly `socket:channel` for them).
 */
export function pusherAuthorizeChannel(
  socketId: string,
  channel: string,
  app: PusherAppConfig,
  userData?: Record<string, unknown>,
): { auth: string; appKey: string } {
  const isPresence = channel.startsWith('presence-');
  let toSign = `${socketId}:${channel}`;
  if (isPresence && userData) {
    toSign += `:${JSON.stringify({ user_id: '', ...userData })}`;
  }
  const sig = crypto.createHmac('sha256', app.secret).update(toSign).digest('hex');
  return { auth: `${app.key}:${sig}`, appKey: app.key };
}

// ─── Beams web push (REST publish API) ─────────────────────────────────────

// Read lazily (like getPusherApps) rather than captured at import time —
// module-load capture freezes the value, which disagrees with the health
// diagnostics in any runtime that populates env after the first import.
function beamsInstanceId(): string {
  return env('BEAMS_INSTANCE_ID') || '';
}
function beamsPrimaryKey(): string {
  return env('BEAMS_PRIMARY_KEY') || '';
}

export function isBeamsConfigured(): boolean {
  return !!(beamsInstanceId() && beamsPrimaryKey());
}

export interface BeamsWebNotification {
  title: string;
  body: string;
  icon?: string;
  deep_link?: string;
}

/**
 * Publish a web push to device interests. Fire-and-forget, never throws.
 * Interests used by the accounts client: `user-<id>`, `broadcast`, `hello`.
 */
export async function beamsPublish(
  interests: string[],
  notification: BeamsWebNotification,
): Promise<boolean> {
  const instanceId = beamsInstanceId();
  const primaryKey = beamsPrimaryKey();
  if (!instanceId || !primaryKey || interests.length === 0) return false;
  try {
    const res = await fetch(
      `https://${instanceId}.pushnotifications.pusher.com/publish_api/v1/instances/${instanceId}/publishes`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${primaryKey}`,
        },
        body: JSON.stringify({
          interests,
          web: {
            notification: {
              title: notification.title,
              body: notification.body,
              ...(notification.icon ? { icon: notification.icon } : {}),
              ...(notification.deep_link ? { deep_link: notification.deep_link } : {}),
            },
          },
        }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      console.warn(`[BEAMS] publish failed: ${res.status} ${(await res.text()).slice(0, 120)}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`[BEAMS] publish error: ${err?.message || err}`);
    return false;
  }
}

/** Push to one user's devices (interest `user-<id>`). */
export async function beamsSendToUser(
  userId: string,
  notification: BeamsWebNotification,
): Promise<boolean> {
  return beamsPublish([`user-${userId}`], notification);
}
