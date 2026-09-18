/**
 * Shared WebSocket delivery helper — tries local WS server first,
 * falls back to Cloudflare Worker publish (wss://ws.tirbeo.app).
 *
 * Used by notifications, support handlers, audit, and form handlers.
 */
import { publishToRealtime } from '@/infrastructure/realtime/rt-publish';

export async function sendToUserWs(userId: string, data: unknown): Promise<void> {
  // 1. Try local WS server (for local dev with running ws server)
  try {
    const { sendToUser } = await import('@/infrastructure/realtime/ws/server');
    sendToUser(userId, data);
    return; // local server also calls publishToRealtime internally
  } catch {
    // WS server not available (Vercel serverless, or not started)
  }
  // 2. Fallback: publish directly to Cloudflare Worker
  try {
    const type = (data as any)?.type || 'event';
    publishToRealtime(
      { userId },
      { type, channel: `user:${userId}`, payload: data as Record<string, unknown> },
    );
  } catch {
    // Cloudflare Worker unreachable — event lost (DB record still exists if applicable)
  }
}

export async function sendBroadcastWs(data: unknown): Promise<void> {
  try {
    const { broadcast } = await import('@/infrastructure/realtime/ws/server');
    broadcast(data);
    return;
  } catch {}
  try {
    const type = (data as any)?.type || 'broadcast';
    publishToRealtime(
      { broadcast: true },
      { type, payload: data as Record<string, unknown> },
    );
  } catch {}
}
