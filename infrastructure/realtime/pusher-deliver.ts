// ═══ PUSHER DELIVERY — Channels realtime + Beams push ═══
// Third delivery layer alongside ws-deliver (Cloudflare WS bridge) and
// push-notifications (self-hosted VAPID). All calls are fire-and-forget:
// they must never throw, never block a response, and never fail a request.
//
// Realtime event contract (must match accounts/src/lib/realtime.ts):
//   private-user-<id>  'notification' → { message, type? }  → in-app toast
//   private-user-<id>  'session'      → { type: 'session_revoked' } → reload
//   announcements      'announcement' → { message }            → top banner

import {
  pusherSendToUser,
  pusherAnnounce,
  isPusherConfigured,
  beamsSendToUser,
  isBeamsConfigured,
  getPusherApps,
  REGION_SUFFIXES,
} from '@/shared/pusher';
import { getDashboardBaseUrl } from '@/config/app-urls';

export function pusherStatus(): { realtime: boolean; push: boolean } {
  return { realtime: isPusherConfigured(), push: isBeamsConfigured() };
}

/**
 * Delivery-layer config diagnostics for /api/health.
 *
 * A missing Pusher secret makes realtime and Beams no-op *silently* — every
 * publish returns `{ok:0}` and no request ever fails. This surfaces which of
 * the 5 regional apps are actually wired up, and names the env vars that are
 * missing, so the misconfiguration is visible from the health endpoint.
 *
 * NEVER returns key/secret values — only app names, clusters and booleans.
 */
export function deliveryDiagnostics(): {
  status: 'ok' | 'degraded';
  realtime: boolean;
  push: boolean;
  allAppsConfigured: boolean;
  apps: { name: string; cluster: string; configured: boolean }[];
  missingEnvVars: string[];
} {
  const configured = new Set(getPusherApps().map((a) => a.name));

  const apps = REGION_SUFFIXES.map((suffix) => {
    const cluster = process.env[`PUSHER_CLUSTER_${suffix}`] || 'mt1';
    return {
      name: suffix.toLowerCase(),
      cluster,
      configured: configured.has(suffix.toLowerCase()),
    };
  });

  // An app is only usable when all three of its credentials are present;
  // report exactly which ones are absent so the fix is unambiguous.
  const missingEnvVars: string[] = [];
  for (const suffix of REGION_SUFFIXES) {
    const appId = process.env[`PUSHER_APP_ID_${suffix}`];
    const key = process.env[`PUSHER_KEY_${suffix}`];
    const secret = process.env[`PUSHER_SECRET_${suffix}`];
    if (appId && key && secret) continue;
    // Ignore regions that were never configured at all (all three blank).
    if (!appId && !key && !secret) {
      missingEnvVars.push(`PUSHER_APP_ID_${suffix}`, `PUSHER_KEY_${suffix}`, `PUSHER_SECRET_${suffix}`);
      continue;
    }
    if (!appId) missingEnvVars.push(`PUSHER_APP_ID_${suffix}`);
    if (!key) missingEnvVars.push(`PUSHER_KEY_${suffix}`);
    if (!secret) missingEnvVars.push(`PUSHER_SECRET_${suffix}`);
  }

  const realtime = isPusherConfigured();
  const push = isBeamsConfigured();
  if (push) {
    if (!process.env.BEAMS_INSTANCE_ID) missingEnvVars.push('BEAMS_INSTANCE_ID');
    if (!process.env.BEAMS_PRIMARY_KEY) missingEnvVars.push('BEAMS_PRIMARY_KEY');
  } else {
    missingEnvVars.push('BEAMS_INSTANCE_ID', 'BEAMS_PRIMARY_KEY');
  }

  // A *partially* configured set is still degraded: clients pick their
  // regional app client-side, so any app missing a secret means those clients
  // silently receive nothing. Only a fully wired set is 'ok'.
  const allAppsConfigured = apps.every((a) => a.configured);

  return {
    status: allAppsConfigured && push ? 'ok' : 'degraded',
    realtime,
    push,
    allAppsConfigured,
    apps,
    missingEnvVars: [...new Set(missingEnvVars)],
  };
}

/**
 * Realtime event to one user's private channel (all regional apps).
 * Used for instant UI updates: toasts, session revocation, live refresh.
 */
export function pusherNotifyUser(
  userId: string,
  event: string,
  data: Record<string, unknown>,
): void {
  if (!isPusherConfigured() || !userId) return;
  void pusherSendToUser(userId, event, data).catch(() => {});
}

/** Same as pusherNotifyUser with the 'notification' event (toast in UI). */
export function pusherToastUser(
  userId: string,
  message: string,
  type?: string,
): void {
  pusherNotifyUser(userId, 'notification', { message, type });
}

/** Tell a user's open tabs their session was revoked (UI reloads itself). */
export function pusherSessionRevoked(userId: string): void {
  pusherNotifyUser(userId, 'session', { type: 'session_revoked' });
}

/** Public announcement — shows the realtime banner on every auth screen. */
export function pusherBroadcastAnnouncement(message: string): void {
  if (!isPusherConfigured()) return;
  void pusherAnnounce(message).catch(() => {});
}

/**
 * Web push to a user's registered browsers via Beams.
 * NOTE: Beams requires opted-in consent. The caller (createNotification)
 * has already applied the user's push preferences + quiet hours — this
 * function only delivers.
 */
export function beamsNotifyUser(
  userId: string,
  title: string,
  body: string,
  deepLink?: string,
  icon?: string,
): void {
  if (!isBeamsConfigured() || !userId) return;
  void beamsSendToUser(userId, {
    title,
    body,
    ...(deepLink ? { deep_link: resolveAppLink(deepLink) } : {}),
    ...(icon ? { icon } : {}),
  }).catch(() => {});
}

// Beams validates `web.notification.deep_link` as a full URI — a relative app
// path like `/account/inbox` is rejected with a 422. Resolve app links (which
// the codebase stores as bare paths) to an absolute dashboard URL before send.
function resolveAppLink(link: string): string {
  if (/^https?:\/\//i.test(link)) return link;
  const base = getDashboardBaseUrl().replace(/\/$/, '');
  return `${base}${link.startsWith('/') ? link : `/${link}`}`;
}
