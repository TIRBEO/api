/**
 * CDN Control Plane — the "leader" API surface for the company CDN.
 *
 * Central API routes (apps/api/app/api/cdn/ctl/*) authenticate with the SAME
 * session cookies every other app uses, then call into this module. It owns:
 *
 *   ── LEADER (central server) ─────────────────────────────────
 *   • cdnStatus():       cluster snapshot (instances, cache, connected WS
 *                        clients) — served by GET /api/cdn/ctl/status
 *   • cdnCommand():      dispatches named commands (cache.warm, cache.clear,
 *                        stats.broadcast) — served by POST /api/cdn/ctl/command
 *   ── FOLLOWERS (this + peer API instances) ───────────────────
 *   • All instances subscribe to the CDN event bus; commands that change
 *     edge state re-publish bus events so every follower converges instantly.
 *
 * Delivery media: the CDN event bus (Redis fanned out across instances) and
 * the realtime platform (ws.tirbeo.app) for remote WS consumers. Sessions are
 * enforced by the routes — this module trusts its caller.
 */

import { publishCdnEvent, type CdnFileChangedEvent } from '@/features/media/cdnRealtime';

// ── Edge byte cache (per process) ────────────────────────────
// The public delivery path (/u/a/...) keeps resolved bytes in an LRU. The
// control plane can pre-warm it so the FIRST request for a hot asset (profile
// pic, media upload, share download) is served from memory instantly.

const PREWARM_CACHE = new Map<string, { bytes: Buffer; mimeType: string; filename: string; at: number }>();
const PREWARM_TTL_MS = 10 * 60_000;
const PREWARM_MAX_BYTES = 64 * 1024 * 1024; // 64 MB per process
/** Public uploads at or under this size are auto-warmed at write time. */
export const AUTO_WARM_MAX_BYTES = 8 * 1024 * 1024;
let prewarmBytes = 0;

function prewarmPut(key: string, value: { bytes: Buffer; mimeType: string; filename: string }): void {
  const existing = PREWARM_CACHE.get(key);
  if (existing) {
    prewarmBytes -= existing.bytes.length;
    PREWARM_CACHE.delete(key);
  }
  PREWARM_CACHE.set(key, { ...value, at: Date.now() });
  prewarmBytes += value.bytes.length;
  // LRU evict (oldest first) until under budget.
  if (prewarmBytes > PREWARM_MAX_BYTES) {
    const entries = [...PREWARM_CACHE.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k, v] of entries) {
      if (prewarmBytes <= PREWARM_MAX_BYTES * 0.8) break;
      PREWARM_CACHE.delete(k);
      prewarmBytes -= v.bytes.length;
    }
  }
}

/** Leader-initiated pre-warm: pull hot files' bytes into every instance's
 *  edge cache via the event bus (this instance warms immediately, peers warm
 *  when the bus event lands). Returns per-file success/failure detail. */
export async function prewarmCdnFiles(fileIds: string[]): Promise<{
  warmed: number;
  failed: number;
  results: Array<{ fileId: string; ok: boolean; size?: number; error?: string }>;
}> {
  const unique = [...new Set(fileIds.filter(Boolean))].slice(0, 200);
  const results: Array<{ fileId: string; ok: boolean; size?: number; error?: string }> = [];
  let warmed = 0;
  let failed = 0;

  for (const fileId of unique) {
    try {
      const { getCdnFileBytes } = await import('@/features/media/cdnStorage');
      const { dto, bytes } = await getCdnFileBytes(fileId);
      if (dto.folder) {
        results.push({ fileId, ok: false, error: 'folder has no bytes' });
        failed += 1;
        continue;
      }
      prewarmPut(fileId, { bytes, mimeType: dto.contentType, filename: dto.filename });
      results.push({ fileId, ok: true, size: bytes.length });
      warmed += 1;
    } catch (err: any) {
      results.push({ fileId, ok: false, error: err?.message || 'not found' });
      failed += 1;
    }
  }

  if (warmed > 0) {
    // Tell every follower instance (and WS consumers) to warm the same ids.
    void publishCdnEvent({
      type: 'cdn.cache.warm',
      fileId: unique[0],
      actorId: 'cdn-control',
      metadata: { fileIds: unique, origin: 'control-plane' },
    }).catch(() => {});
  }
  return { warmed, failed, results };
}

/** Apply a follower-side warm event (called from the bus subscription). */
export async function applyPrewarmEvent(fileIds: string[]): Promise<void> {
  for (const fileId of fileIds.slice(0, 200)) {
    if (hasPrewarmedBytes(fileId)) continue; // already hot — skip the DB read
    try {
      const { getCdnFileBytes } = await import('@/features/media/cdnStorage');
      const { dto, bytes } = await getCdnFileBytes(fileId);
      if (!dto.folder) {
        prewarmPut(fileId, { bytes, mimeType: dto.contentType, filename: dto.filename });
      }
    } catch {
      // file may be gone — skip
    }
  }
}

/**
 * Zero-I/O warm: seed the edge cache with bytes already in hand (called at
 * upload time — no extra DB fetch). Only small-enough PUBLIC files qualify;
 * the caller checks visibility. Returns true when seeded.
 */
export function warmBytesDirect(
  fileId: string,
  bytes: Buffer,
  mimeType: string | null | undefined,
  filename: string,
): boolean {
  if (!fileId || !bytes || bytes.length === 0 || bytes.length > AUTO_WARM_MAX_BYTES) return false;
  prewarmPut(fileId, { bytes, mimeType: mimeType || 'application/octet-stream', filename });
  return true;
}

/** Drop one file's warmed bytes (visibility flip, delete, hygiene). */
export function dropPrewarmed(fileId: string): void {
  const existing = PREWARM_CACHE.get(fileId);
  if (existing) {
    prewarmBytes -= existing.bytes.length;
    PREWARM_CACHE.delete(fileId);
  }
}

/** True when this process holds the bytes for `fileId` hot in memory. */
export function hasPrewarmedBytes(fileId: string): boolean {
  const hit = PREWARM_CACHE.get(fileId);
  return !!hit && Date.now() - hit.at < PREWARM_TTL_MS;
}

/** Take the pre-warmed bytes for a file (used by the /u/ delivery path). */
export function takePrewarmedBytes(
  fileId: string,
): { bytes: Buffer; mimeType: string; filename: string } | null {
  const hit = PREWARM_CACHE.get(fileId);
  if (!hit || Date.now() - hit.at >= PREWARM_TTL_MS) return null;
  hit.at = Date.now(); // touch
  return { bytes: hit.bytes, mimeType: hit.mimeType, filename: hit.filename };
}

/** Clear every warmed byte from this instance (cache.clear command). */
export function clearPrewarmCache(): number {
  const count = PREWARM_CACHE.size;
  PREWARM_CACHE.clear();
  prewarmBytes = 0;
  return count;
}

// ── Event counters (per event-type channel, this process) ───
// Every cdn.* event published through the bus is counted here: lifetime
// total + rolling last-hour window. These power the control-plane snapshot's
// per-channel breakdown so operators can see which channels are hot.

const EVENT_WINDOW_MS = 60 * 60_000; // last hour (default view)
/** 24h view support: caps how long per-event timestamps are retained.
 *  Windows are PRUNED against the requested range at read time, so the same
 *  buffer serves both the 1h default and ?range=24h. */
const EVENT_RETENTION_MS = 24 * 60 * 60_000;
const EVENT_WINDOW_CAP = 20_000; // per type — plenty for a 24h hot channel

const eventCountTotals = new Map<string, number>();
const eventCountWindow = new Map<string, number[]>();
let eventCountLastPrune = 0;

/** Count one published event (called from the publish chokepoint). */
export function recordEventCount(type: string): void {
  if (!type || !type.startsWith('cdn.')) return;
  eventCountTotals.set(type, (eventCountTotals.get(type) ?? 0) + 1);
  let window = eventCountWindow.get(type);
  if (!window) {
    window = [];
    eventCountWindow.set(type, window);
  }
  window.push(Date.now());
  if (window.length > EVENT_WINDOW_CAP) window.splice(0, window.length - EVENT_WINDOW_CAP);
  maybePruneEventCounts();
}

/** Drop every counted event (totals + time windows). Invoked by the
 *  `stats.reset` control-plane command on every instance via the bus. */
export function clearEventCounts(): number {
  let cleared = 0;
  for (const n of eventCountTotals.values()) cleared += n;
  eventCountTotals.clear();
  eventCountWindow.clear();
  eventCountLastPrune = 0;
  return cleared;
}

function maybePruneEventCounts(): void {
  const now = Date.now();
  if (now - eventCountLastPrune < 60_000) return;
  eventCountLastPrune = now;
  // Prune against the max retention (24h) — narrower ranges are filtered at
  // read time so the 1h and 24h views share one buffer.
  for (const window of eventCountWindow.values()) {
    while (window.length > 0 && window[0] <= now - EVENT_RETENTION_MS) window.shift();
  }
}

export interface CdnEventChannelStat {
  /** Since boot (this instance). */
  total: number;
  /** Within the requested range (default: rolling last hour). */
  inRange: number;
  /** Rolling last hour — kept for backward compatibility. */
  lastHour: number;
  /** Epoch ms of the most recent event, null when silent. */
  lastAt: number | null;
}

export const CDN_STATUS_RANGES = [1, 24] as const;

/**
 * Aggregate the event counters over a rolling window.
 * @param rangeHours 1 (default) or 24 — how far back `inRange` reaches.
 */
function eventCountStats(rangeHours: 1 | 24 = 1): {
  rangeHours: 1 | 24;
  total: number;
  inRange: number;
  lastHour: number;
  lastAt: number | null;
  perMinute: number[];
  byType: Record<string, CdnEventChannelStat>;
} {
  maybePruneEventCounts();
  const now = Date.now();
  const rangeMs = rangeHours * 60 * 60_000;
  const byType: Record<string, CdnEventChannelStat> = {};
  let total = 0;
  let inRange = 0;
  let lastHour = 0;
  let lastAt: number | null = null;
  // Per-minute histogram for the UI sparkline: 60 buckets spanning the whole
  // requested range, OLDEST → NEWEST (bucket 59 = the current slot).
  const bucketMs = Math.max(rangeMs / 60, 1);
  const perMinute = new Array<number>(60).fill(0);
  for (const [type, count] of eventCountTotals) {
    const all = (eventCountWindow.get(type) ?? []).filter((t) => t > now - EVENT_RETENTION_MS);
    const window = all.filter((t) => t > now - rangeMs);
    const hourWindow = rangeHours === 1 ? window : all.filter((t) => t > now - EVENT_WINDOW_MS);
    byType[type] = {
      total: count,
      inRange: window.length,
      lastHour: hourWindow.length,
      lastAt: all.length > 0 ? all[all.length - 1] : null,
    };
    total += count;
    inRange += window.length;
    lastHour += hourWindow.length;
    const typeLast = all.length > 0 ? all[all.length - 1] : null;
    if (typeLast !== null && (lastAt === null || typeLast > lastAt)) lastAt = typeLast;
    for (const t of window) {
      const bucket = 59 - Math.floor((now - t) / bucketMs);
      if (bucket >= 0 && bucket < 60) perMinute[bucket] += 1;
    }
  }
  return { rangeHours, total, inRange, lastHour, lastAt, perMinute, byType };
}

// ── Status ──────────────────────────────────────────────────

export interface CdnStatusSnapshot {
  service: string;
  leader: { instance: string; region: string; now: number; uptimeSeconds: number };
  cache: { entries: number; bytes: number; maxBytes: number; hit: boolean };
  websocket: {
    enabled: boolean;
    connectedClients: number;
    transport: string;
    /** Live subscriber count per WS channel (cdn, user:<id>, admin, …). */
    channels: Record<string, number>;
  };
  /** Published cdn.* events, per event-type channel (this instance). */
  events: {
    /** Which rolling window this snapshot covers: 1h (default) or 24h. */
    rangeHours: 1 | 24;
    total: number;
    /** Events within the requested range (default = lastHour). */
    inRange: number;
    lastHour: number;
    /** Epoch ms of the most recent event across all types, null = quiet. */
    lastAt: number | null;
    /** 60 buckets across the requested range, oldest → newest (sparkline). */
    perMinute: number[];
    byType: Record<string, CdnEventChannelStat>;
  };
  storage: { backend: string; maxUploadBytes: number };
  realtime: { ssePath: string; wsChannel: string; platform: string | null };
}

export async function cdnStatus(rangeHours: 1 | 24 = 1): Promise<CdnStatusSnapshot> {
  // Live client count + per-channel subscriptions from the embedded WS server
  // when it's running (the registries live on globalThis, so route bundles see
  // the same maps without importing the ws server module into route bundles).
  const g = globalThis as any;
  const wsClients =
    g.__tirbeoWsClients instanceof Map ? (g.__tirbeoWsClients as Map<string, unknown>).size : 0;
  const wsSubs =
    g.__tirbeoWsChannelSubs instanceof Map
      ? (g.__tirbeoWsChannelSubs as Map<string, Set<string>>)
      : null;
  const wsChannels: Record<string, number> = {};
  if (wsSubs) {
    for (const [channel, set] of wsSubs) {
      if (set.size > 0) wsChannels[channel] = set.size;
    }
  }
  const platform = process.env.NEXT_PUBLIC_WS_URL || (process.env.RT_API_TOKEN ? 'wss://ws.tirbeo.app/ws' : null);

  return {
    service: 'tirbeo-cdn-control-plane',
    leader: {
      instance: process.env.CDN_INSTANCE_ID || `api-${process.pid}`,
      region: process.env.CDN_REGION || process.env.VERCEL_REGION || 'local',
      now: Date.now(),
      uptimeSeconds: Math.round(process.uptime()),
    },
    cache: {
      entries: PREWARM_CACHE.size,
      bytes: prewarmBytes,
      maxBytes: PREWARM_MAX_BYTES,
      hit: PREWARM_CACHE.size > 0,
    },
    websocket: {
      enabled: wsPortEnabled(),
      connectedClients: wsClients,
      transport: wsPortEnabled() ? 'ws://api:3001/ws + wss://ws.tirbeo.app/ws' : 'wss://ws.tirbeo.app/ws',
      channels: wsChannels,
    },
    events: eventCountStats(rangeHours),
    storage: {
      backend: 'cockroachdb',
      maxUploadBytes: 100 * 1024 * 1024,
    },
    realtime: {
      ssePath: '/api/cdn/events',
      wsChannel: 'cdn',
      platform,
    },
  };
}

function wsPortEnabled(): boolean {
  if (process.env.VERCEL) return false;
  if (process.env.WS_PORT !== undefined) return parseInt(process.env.WS_PORT || '', 10) > 0;
  return process.env.NODE_ENV === 'development';
}

// ── Commands (the leader speaks; followers execute) ─────────

export type CdnCommandName = 'cache.warm' | 'cache.clear' | 'stats.broadcast' | 'stats.reset';

export interface CdnCommandResult {
  ok: boolean;
  command: CdnCommandName;
  detail: Record<string, unknown>;
}

export async function cdnCommand(
  command: CdnCommandName,
  args: { fileIds?: string[] } = {},
): Promise<CdnCommandResult> {
  switch (command) {
    case 'cache.warm': {
      const ids = args.fileIds ?? [];
      if (ids.length === 0) {
        return { ok: false, command, detail: { error: 'fileIds[] is required for cache.warm' } };
      }
      const res = await prewarmCdnFiles(ids);
      return {
        ok: res.warmed > 0,
        command,
        detail: { warmed: res.warmed, failed: res.failed, results: res.results.slice(0, 20) },
      };
    }
    case 'cache.clear': {
      const cleared = clearPrewarmCache();
      void publishCdnEvent({
        type: 'cdn.cache.cleared',
        fileId: '',
        actorId: 'cdn-control',
        metadata: { cleared, origin: 'control-plane' },
      }).catch(() => {});
      return { ok: true, command, detail: { cleared } };
    }
    case 'stats.broadcast': {
      const snapshot = await cdnStatus();
      void publishCdnEvent({
        type: 'cdn.stats.broadcast',
        fileId: '',
        actorId: 'cdn-control',
        metadata: { status: snapshot },
      }).catch(() => {});
      return { ok: true, command, detail: { status: snapshot } };
    }
    case 'stats.reset': {
      // Local counters drop now; followers drop theirs when the bus event
      // below reaches them (Redis fans it across instances).
      const cleared = clearEventCounts();
      void publishCdnEvent({
        type: 'cdn.stats.reset',
        fileId: '',
        actorId: 'cdn-control',
        metadata: { cleared, origin: 'control-plane' },
      }).catch(() => {});
      return { ok: true, command, detail: { cleared } };
    }
    default:
      return { ok: false, command: command as CdnCommandName, detail: { error: 'Unknown command' } };
  }
}

export const CDN_COMMANDS: Array<{ name: CdnCommandName; description: string; args?: string }> = [
  { name: 'cache.warm', description: 'Pre-load file bytes into the edge cache on every instance (instant first serve for profile pics / media / shares).', args: 'fileIds: string[]' },
  { name: 'cache.clear', description: 'Drop all warmed bytes from the edge cache across the cluster.' },
  { name: 'stats.broadcast', description: 'Push a fresh cluster status snapshot to all connected realtime clients.' },
  { name: 'stats.reset', description: 'Zero the per-channel event counters on every instance (totals + time windows).' },
];

// ── Follower wiring: react to control-plane bus events ──────

let followerBound = false;

/** Bind ONCE per process: follower instances execute leader cache commands
 *  as they arrive on the bus (Redis fans them out across instances). */
export function bindCdnControlFollower(): void {
  if (followerBound) return;
  followerBound = true;
  import('@/features/media/cdnRealtime')
    .then(({ subscribeCdnEvents }) => {
      subscribeCdnEvents((event: CdnFileChangedEvent) => {
        if (event.type === 'cdn.cache.warm') {
          const ids = Array.isArray(event.metadata?.fileIds) ? (event.metadata!.fileIds as string[]) : [];
          if (ids.length > 0) void applyPrewarmEvent(ids);
        } else if (event.type === 'cdn.cache.cleared') {
          clearPrewarmCache();
        } else if (event.type === 'cdn.stats.reset') {
          clearEventCounts();
        }
      });
    })
    .catch(() => {});
}

// ── Platform mirror (ws.tirbeo.app) ─────────────────────────

const MIRROR_ALLOW = new Set([
  'cdn.file.upload',
  'cdn.file.create_folder',
  'cdn.file.rename',
  'cdn.file.share_link',
  'cdn.share.redeemed',
  'cdn.cache.warm',
  'cdn.cache.cleared',
  'cdn.stats.broadcast',
  'cdn.stats.reset',
]);

/** Fire-and-forget mirror of a CDN bus event into the realtime platform so
 *  WS consumers (apps, embeds, dashboards) receive it instantly. */
export function mirrorCdnEventToPlatform(event: CdnFileChangedEvent): void {
  if (!MIRROR_ALLOW.has(event.type)) return;
  void import('@/infrastructure/realtime/rt-publish')
    .then(({ sendRealtimeToChannel }) => {
      sendRealtimeToChannel('cdn', {
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
      });
    })
    .catch(() => {
      // rt-publish absent or RT_API_TOKEN unset — local/Redis delivery continues.
    });
}

// ── Creator alerts (share-link redemptions) ─────────────────

const ALERT_TTL_MS = 2 * 60_000; // dedupe window for repeated redemptions
const recentAlerts = new Map<string, number>();

/**
 * Push a share-redemption ALERT to the file owner over WebSocket — not the
 * broadcast "cdn" channel. `sendToUser` targets the owner's `user:<id>`
 * channel (auth-gated: only the owner can subscribe to it), then mirrors to
 * the realtime platform. Fire-and-forget: a WS hiccup never affects the
 * redeem flow, which already logged activity + published the bus event.
 */
export function alertCreatorShareRedeemed(input: {
  creatorId: string | null | undefined;
  fileId: string;
  filename: string;
  token: string;
  /** Shared with the bus event so client dedupe keys line up. */
  at?: number;
}): void {
  const creatorId = input.creatorId;
  if (!creatorId) return; // anonymous-owner edge — nothing to target
  const key = `${input.token}:${creatorId}`;
  const now = input.at ?? Date.now();
  const last = recentAlerts.get(key);
  if (last && now - last < ALERT_TTL_MS) return; // same link, same 2 min
  recentAlerts.set(key, now);
  if (recentAlerts.size > 500) {
    for (const [k, at] of recentAlerts) {
      if (now - at >= ALERT_TTL_MS) recentAlerts.delete(k);
    }
  }
  // Dynamic import (NOT require): route bundles run under Turbopack where
  // require() of app-aliased modules can fail — import() is proven to work
  // here (same pattern as the publish chokepoint in cdnRealtime.ts).
  void import('@/infrastructure/realtime/ws/server')
    .then(({ sendToUser }) => {
      sendToUser(creatorId, {
        type: 'alert',
        alert: {
          kind: 'share.redeemed',
          title: 'Share link opened',
          body: `🔓 "${input.filename}" — your one-time link was just opened`,
          fileId: input.fileId,
          filename: input.filename,
          token: input.token,
          at: now,
        },
      });
    })
    .catch(() => {
      // Embedded WS server not running (e.g. serverless) — bus event + mirror
      // above already cover every other consumer.
    });
}
