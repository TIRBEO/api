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
} from '@tirbeo/pusher';
import { getDashboardBaseUrl } from '@/config/app-urls';

export function pusherStatus(): { realtime: boolean; push: boolean } {
  return { realtime: isPusherConfigured(), push: isBeamsConfigured() };
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
