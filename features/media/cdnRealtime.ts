import { EventEmitter } from 'node:events';

/**
 * Company CDN realtime bus.
 *
 * Every file mutation publishes a `cdn.file.*` event here. The SSE route
 * (/api/cdn/events) subscribes and pushes to connected clients instantly —
 * no polling. Redis pub/sub mirrors events across API instances so the feed
 * is realtime even with multiple server processes.
 *
 * The embedded WS server (ws/server.ts via cdnWsBridge) multiplexes the same
 * stream onto the "cdn" channel, and cdnControl.ts mirrors every event into
 * the realtime platform (wss://ws.tirbeo.app/ws) so remote consumers receive
 * it over WebSocket the moment it happens.
 *
 * Event shapes intentionally mirror the DTOs in cdnStorage.ts so the client
 * can patch its state without a refetch.
 */

export interface CdnFileChangedEvent {
  type:
    | 'cdn.file.upload'
    | 'cdn.file.create_folder'
    | 'cdn.file.rename'
    | 'cdn.file.star'
    | 'cdn.file.unstar'
    | 'cdn.file.trash'
    | 'cdn.file.restore'
    | 'cdn.file.move'
    | 'cdn.file.delete_permanent'
    | 'cdn.file.self_destruct_set'
    | 'cdn.file.self_destruct_cleared'
    | 'cdn.file.opened'
    | 'cdn.file.share_link'
    | 'cdn.file.make_public'
    | 'cdn.file.make_private'
    | 'cdn.share.redeemed'
    // ── Edge cache control plane (leader → all instances) ──
    // Fired whenever the byte cache is programmatically warmed/cleared so
    // every instance stays coherent, and on periodic stats broadcasts.
    | 'cdn.cache.warm'
    | 'cdn.cache.cleared'
    | 'cdn.stats.broadcast'
    | 'cdn.stats.reset';
  fileId: string;
  actorId: string;
  /** Full DTO after the mutation — lets clients patch state with zero refetch. */
  file?: Record<string, unknown>;
  filename?: string | null;
  metadata?: Record<string, unknown>;
  /** Optional on publish — publishCdnEvent stamps it before emitting. */
  at?: number;
}

const CHANNEL = 'tirbeo:cdn:events';

const g = globalThis as any;

// Local in-process fan-out
if (!g.__tirbeoCdnBus) g.__tirbeoCdnBus = new EventEmitter();
const bus: EventEmitter = g.__tirbeoCdnBus;
// SSE clients can be numerous; raise the default (10) listener ceiling.
bus.setMaxListeners(0);

// Redis subscriber (single per process). Lazy — Redis is optional.
let redisSubReady = false;

async function getRedisPublisher(): Promise<any | null> {
  if (!process.env.REDIS_URL) return null;
  try {
    const { getCachedRedisClient } = await import('@/infrastructure/db/redis');
    return getCachedRedisClient('cdn-pub', { onReconnect: undefined });
  } catch {
    return null;
  }
}

async function ensureRedisSubscriber(): Promise<void> {
  if (redisSubReady || !process.env.REDIS_URL) return;
  redisSubReady = true;
  try {
    const { getCachedRedisClient } = await import('@/infrastructure/db/redis');
    const sub = getCachedRedisClient('cdn-sub');
    // duplicate() gives us a dedicated connection in subscriber mode. NOTE:
    // ioredis duplicates do NOT inherit the parent's listeners, so we must add
    // a persistent error handler up front — otherwise a Redis outage raises
    // "[ioredis] Unhandled error event" and can crash the process.
    const subConn = typeof sub.duplicate === 'function' ? sub.duplicate() : sub;
    subConn.on('error', () => {}); // swallow — local in-process fan-out still works
    await new Promise<void>((resolve, reject) => {
      if (subConn.status === 'ready') return resolve();
      subConn.once('ready', resolve);
      subConn.once('error', reject);
      // ioredis needs an explicit connect for lazyConnect clients
      if (subConn.status === 'wait') subConn.connect().catch(reject);
    });
    await subConn.subscribe(CHANNEL);
    subConn.on('message', (channel: string, message: string) => {
      if (channel !== CHANNEL) return;
      try {
        bus.emit('event', JSON.parse(message));
      } catch {
        // ignore malformed payloads
      }
    });
    // If the subscriber connection is dropped (network blip, Upstash idle
    // timeout), clear readiness and retry so cross-instance fan-out comes back
    // on its own instead of silently staying local forever.
    subConn.on('end', () => {
      redisSubReady = false;
      try { subConn.removeAllListeners(); } catch {}
      setTimeout(() => void ensureRedisSubscriber(), 5_000);
    });
    console.log('[CDN-RT] Redis fan-out subscribed');
  } catch (err: any) {
    redisSubReady = false;
    console.warn('[CDN-RT] Redis fan-out unavailable, events stay local to this instance:', err?.message);
  }
}

/** Publish a file-change event to all connected clients (all instances). */
export async function publishCdnEvent(event: CdnFileChangedEvent): Promise<void> {
  // Guarantee a timestamp.
  const payload: CdnFileChangedEvent = { ...event, at: event.at || Date.now() };
  // Per-channel counter for the control-plane snapshot (fire-and-forget).
  try {
    const { recordEventCount } = await import('@/features/media/cdnControl');
    recordEventCount(payload.type);
  } catch {
    // counters are best-effort
  }
  bus.emit('event', payload); // local clients hear it immediately
  void ensureRedisSubscriber().then(() => getRedisPublisher()).then((pub) => {
    if (pub) pub.publish(CHANNEL, JSON.stringify(payload)).catch(() => {});
  });
  // Mirror into the realtime platform (ws.tirbeo.app) so WS consumers get the
  // event without polling. Fire-and-forget, never throws.
  try {
    const { mirrorCdnEventToPlatform } = await import('@/features/media/cdnControl');
    mirrorCdnEventToPlatform(payload);
  } catch {
    // control plane unavailable — local + Redis fan-out still work
  }
}

/** Subscribe to CDN events (used by the SSE route). Returns an unsubscribe. */
export function subscribeCdnEvents(listener: (event: CdnFileChangedEvent) => void): () => void {
  void ensureRedisSubscriber();
  bus.on('event', listener);
  return () => bus.off('event', listener);
}
