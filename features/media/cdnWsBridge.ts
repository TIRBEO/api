import { subscribeCdnEvents } from '@/features/media/cdnRealtime';

/**
 * Bridges company-CDN realtime events onto the API's WebSocket server so
 * OTHER apps (dashboards, embeds) can subscribe without SSE:
 *
 *   ws auth  → { type: "auth", token: "<jwt>" }
 *   then     → { type: "subscribe", channel: "cdn" }
 *   receives → { type: "event", channel: "cdn", event: CdnFileChangedEvent }
 */
export function startCdnWsBridge(): void {
  const g = globalThis as any;
  if (g.__tirbeoCdnWsBridge) return;
  g.__tirbeoCdnWsBridge = true;
  subscribeCdnEvents((event) => {
    try {
      // Lazy import avoids a hard dependency when the WS server isn't running.
      const { sendToChannel } = require('@/infrastructure/realtime/ws/server') as {
        sendToChannel: (channel: string, data: unknown) => void;
      };
      sendToChannel('cdn', { type: event.type, payload: event });
    } catch {
      // WS server not running — SSE remains the transport for the CDN app.
    }
  });
}
