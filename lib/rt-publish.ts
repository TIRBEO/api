import { randomUUID } from 'crypto';

/**
 * Publish events from api.tirbeo.app into the Tirbeo Realtime Platform.
 *
 * The realtime platform (wss://ws.tirbeo.app/ws) is a Cloudflare Worker that
 * only accepts events over HTTP `POST /api/publish` (Bearer token) — it has no
 * shared Redis channel. This module fans api events out to that endpoint.
 * Fire-and-forget: never throws, never blocks callers. If the Worker is
 * unreachable the call is a no-op (local WebSocket delivery still works).
 */

const DEFAULT_PUBLISH_URL = 'https://ws.tirbeo.app/api/publish';
const PUBLISH_TIMEOUT_MS = 5_000;

function publishUrl(): string {
  const explicit = process.env.RT_PUBLISH_URL;
  if (explicit) return explicit;
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
  if (wsUrl) {
    try {
      const u = new URL(wsUrl);
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
      u.pathname = '/api/publish';
      return u.toString();
    } catch {
      /* fall through to default */
    }
  }
  return DEFAULT_PUBLISH_URL;
}

export interface RtPublishTarget {
  userId?: string;
  channel?: string;
  broadcast?: boolean;
}

export interface RtEventInput {
  type: string;
  channel?: string;
  actor?: { id: string; email?: string };
  app?: string;
  resource?: string;
  resourceId?: string;
  org?: string;
  workspace?: string;
  payload: Record<string, unknown>;
  version?: number;
  correlationId?: string;
}

function buildEvent(target: RtPublishTarget, input: RtEventInput): Record<string, unknown> {
  return {
    type: input.type,
    channel: input.channel || (target.userId ? `user:${target.userId}` : ''),
    actor: input.actor,
    app: input.app,
    resource: input.resource,
    resourceId: input.resourceId,
    org: input.org,
    workspace: input.workspace,
    payload: input.payload,
    version: input.version ?? 1,
    timestamp: new Date().toISOString(),
  };
}

export function publishToRealtime(target: RtPublishTarget, input: RtEventInput): boolean {
  try {
    const token = process.env.RT_API_TOKEN;
    if (!token) return false;
    const event = buildEvent(target, input);
    void fetch(publishUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...target, event }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    }).catch(() => {
      /* non-fatal: local delivery still happens */
    });
    return true;
  } catch {
    return false;
  }
}

/** Send a realtime event to a single user via their `user:{id}` channel. */
export function sendRealtimeToUser(userId: string, input: RtEventInput): boolean {
  return publishToRealtime({ userId }, input);
}

/** Broadcast a realtime event to every subscriber of a channel. */
export function sendRealtimeToChannel(channel: string, input: RtEventInput): boolean {
  return publishToRealtime({ channel }, { ...input, channel });
}

/** Broadcast a realtime event to all app-wide subscribers (admin/support/dashboard). */
export function sendRealtimeBroadcast(input: RtEventInput): boolean {
  return publishToRealtime({ broadcast: true }, input);
}
