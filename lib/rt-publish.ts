import { randomUUID } from 'crypto';
import { getCachedRedisClient } from './db/redis';

/**
 * Publish events from api.tirbeo.app into the Tirbeo Realtime Platform.
 *
 * The realtime platform (wss://ws.tirbeo.app/ws) shares the same Upstash Redis
 * instance and subscribes to `{RT_NAMESPACE}:events`, so publishing there fans
 * events out to every subscribed client — across Vercel instances. If Redis is
 * unavailable the call is a no-op (local WebSocket delivery still works).
 */

const RT_NAMESPACE = process.env.RT_NAMESPACE || 'tirbeo:rt';
const EVENT_CHANNEL = `${RT_NAMESPACE}:events`;

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

export function publishToRealtime(target: RtPublishTarget, input: RtEventInput): boolean {
  try {
    const redis = getCachedRedisClient('rt-publish');
    if (!redis) return false;
    const event = {
      id: randomUUID(),
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
    const envelope = { instanceId: 'api', target, event };
    void redis.publish(EVENT_CHANNEL, JSON.stringify(envelope));
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
