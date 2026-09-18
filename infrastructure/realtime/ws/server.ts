import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { getSessionFromToken } from '@/features/auth/session';
import { publishToRealtime } from '@/infrastructure/realtime/rt-publish';

interface WsClient {
  ws: WebSocket;
  userId: string;
  email: string;
  alive: boolean;
  adminRole?: string;
  roomId?: string;
}

// Keep the connection registries on globalThis so the server entry and the
// route-handler bundles share the same instance. Turbopack can instantiate a
// module separately per bundle — split maps would make sendToUser silently miss.
const g = globalThis as any;
if (!g.__tirbeoWsClients) g.__tirbeoWsClients = new Map<string, WsClient>();
if (!g.__tirbeoWsUserConns) g.__tirbeoWsUserConns = new Map<string, Set<string>>();
if (!g.__tirbeoLastSeen) g.__tirbeoLastSeen = new Map<string, number>();
if (!g.__tirbeoWsChannelSubs) g.__tirbeoWsChannelSubs = new Map<string, Set<string>>();
const clients: Map<string, WsClient> = g.__tirbeoWsClients;
const userConnections: Map<string, Set<string>> = g.__tirbeoWsUserConns;
const lastSeenTimes: Map<string, number> = g.__tirbeoLastSeen;
const channelSubs: Map<string, Set<string>> = g.__tirbeoWsChannelSubs;

let wss: WebSocketServer | null = null;

// Server health and hints
interface ServerHints {
  health: 'healthy' | 'degraded' | 'overloaded';
  connectionCount: number;
  maxConnections: number;
  loadFactor: number;        // 0-1, higher = more loaded
  recommendedDelay: number;  // ms, server-recommended reconnection delay
  maintenanceMode: boolean;
  rateLimitRemaining: number;
  serverTime: number;
}

const MAX_CONNECTIONS = 10000;
let lastHintsBroadcast = 0;
const HINTS_BROADCAST_INTERVAL = 30000; // 30 seconds

// Rate limiting configuration
interface RateLimitConfig {
  maxConnectionsPerIp: number;
  connectionWindowMs: number;
  maxMessagesPerSecond: number;
  maxMessagesPerMinute: number;
  maxBurstMessages: number;
  burstWindowMs: number;
}

const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxConnectionsPerIp: 5,
  connectionWindowMs: 60000,
  maxMessagesPerSecond: 50,
  maxMessagesPerMinute: 1000,
  maxBurstMessages: 100,
  burstWindowMs: 10000,
};

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface MessageRateLimit {
  second: RateLimitEntry;
  minute: RateLimitEntry;
  burst: RateLimitEntry;
}

const g3 = globalThis as any;
if (!g3.__tirbeoRateLimits) {
  g3.__tirbeoRateLimits = {
    connections: new Map<string, RateLimitEntry>(),
    messages: new Map<string, MessageRateLimit>(),
  };
}
const rateLimits = g3.__tirbeoRateLimits as {
  connections: Map<string, RateLimitEntry>;
  messages: Map<string, MessageRateLimit>;
};

function isRateLimited(key: string, limit: number, windowMs: number, store: Map<string, RateLimitEntry>): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = store.get(key);
  
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
  }
  
  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }
  
  entry.count++;
  return { allowed: true, remaining: limit - entry.count, resetAt: entry.resetAt };
}

function checkConnectionRateLimit(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  return isRateLimited(
    `conn:${ip}`,
    DEFAULT_RATE_LIMIT_CONFIG.maxConnectionsPerIp,
    DEFAULT_RATE_LIMIT_CONFIG.connectionWindowMs,
    rateLimits.connections
  );
}

function checkMessageRateLimit(clientId: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let entry = rateLimits.messages.get(clientId);
  
  if (!entry) {
    entry = {
      second: { count: 0, resetAt: now + 1000 },
      minute: { count: 0, resetAt: now + 60000 },
      burst: { count: 0, resetAt: now + DEFAULT_RATE_LIMIT_CONFIG.burstWindowMs },
    };
    rateLimits.messages.set(clientId, entry);
  }
  
  if (now > entry.second.resetAt) {
    entry.second = { count: 1, resetAt: now + 1000 };
  } else if (entry.second.count >= DEFAULT_RATE_LIMIT_CONFIG.maxMessagesPerSecond) {
    return { allowed: false, remaining: 0, resetAt: entry.second.resetAt };
  } else {
    entry.second.count++;
  }
  
  if (now > entry.minute.resetAt) {
    entry.minute = { count: 1, resetAt: now + 60000 };
  } else if (entry.minute.count >= DEFAULT_RATE_LIMIT_CONFIG.maxMessagesPerMinute) {
    return { allowed: false, remaining: 0, resetAt: entry.minute.resetAt };
  } else {
    entry.minute.count++;
  }
  
  if (now > entry.burst.resetAt) {
    entry.burst = { count: 1, resetAt: now + DEFAULT_RATE_LIMIT_CONFIG.burstWindowMs };
  } else if (entry.burst.count >= DEFAULT_RATE_LIMIT_CONFIG.maxBurstMessages) {
    return { allowed: false, remaining: 0, resetAt: entry.burst.resetAt };
  } else {
    entry.burst.count++;
  }
  
  const remaining = Math.min(
    DEFAULT_RATE_LIMIT_CONFIG.maxMessagesPerSecond - entry.second.count,
    DEFAULT_RATE_LIMIT_CONFIG.maxMessagesPerMinute - entry.minute.count,
    DEFAULT_RATE_LIMIT_CONFIG.maxBurstMessages - entry.burst.count
  );
  
  return { allowed: true, remaining: Math.max(0, remaining), resetAt: entry.burst.resetAt };
}

function cleanupRateLimits(): void {
  const now = Date.now();
  
  for (const [key, entry] of rateLimits.connections) {
    if (now > entry.resetAt) {
      rateLimits.connections.delete(key);
    }
  }
  
  for (const [key, entry] of rateLimits.messages) {
    if (now > entry.second.resetAt && now > entry.minute.resetAt && now > entry.burst.resetAt) {
      rateLimits.messages.delete(key);
    }
  }
}

function getRateLimitStatus(ip: string): { connectionLimit: number; connectionRemaining: number } {
  const entry = rateLimits.connections.get(`conn:${ip}`);
  const now = Date.now();
  
  if (!entry || now > entry.resetAt) {
    return {
      connectionLimit: DEFAULT_RATE_LIMIT_CONFIG.maxConnectionsPerIp,
      connectionRemaining: DEFAULT_RATE_LIMIT_CONFIG.maxConnectionsPerIp,
    };
  }
  
  return {
    connectionLimit: DEFAULT_RATE_LIMIT_CONFIG.maxConnectionsPerIp,
    connectionRemaining: Math.max(0, DEFAULT_RATE_LIMIT_CONFIG.maxConnectionsPerIp - entry.count),
  };
}

// Maintenance mode state — lives in a dependency-free module so the
// middleware can import it without pulling Prisma into the bundle.
// State itself is on globalThis (see maintenance-state.ts), so all bundles
// share the same object; this module only owns the scheduler + WS broadcast.
import { getMaintenanceState as _getMaintenanceState, setMaintenanceMode as _setMaintenanceMode, tickMaintenanceSchedule } from '@/shared/maintenance-state';
type MaintenanceState = ReturnType<typeof _getMaintenanceState>;
const maintenanceState = new Proxy({} as MaintenanceState, {
  get(_t, prop) { return (_getMaintenanceState() as any)[prop]; },
});

let maintenanceSchedulerTimer: ReturnType<typeof setTimeout> | null = null;

async function logMaintenanceAuditEvent(action: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    const { createAuditEvent } = await import('@/features/security/audit');
    await createAuditEvent({
      action,
      targetType: 'maintenance',
      targetId: 'system',
      metadata,
      severity: action.includes('ENABLED') ? 'warning' : 'info',
    });
  } catch (err) {
    console.error('[MAINTENANCE] Failed to log audit event:', err);
  }
}

function startMaintenanceScheduler(): void {
  if (maintenanceSchedulerTimer) return;
  
  function scheduleMaintenanceCheck() {
    maintenanceSchedulerTimer = setTimeout(async () => {
      const now = Date.now();
      
      const tick = tickMaintenanceSchedule();
      if (tick.autoEnabled) {
        console.log('[MAINTENANCE] Auto-enabling maintenance mode (scheduled)');
        broadcastMaintenanceStatus();
        await logMaintenanceAuditEvent('MAINTENANCE_MODE_ENABLED_AUTO', {
          scheduledStart: new Date(_getMaintenanceState().scheduledStart ?? now).toISOString(),
          scheduledEnd: _getMaintenanceState().scheduledEnd ? new Date(_getMaintenanceState().scheduledEnd!).toISOString() : null,
          message: maintenanceState.message,
          reason: 'scheduled_start_time_reached',
        });
      }
      if (tick.autoDisabled) {
        console.log('[MAINTENANCE] Auto-disabling maintenance mode (scheduled end)');
        const durationMs = now - maintenanceState.startTime;
        const durationMinutes = Math.round(durationMs / (1000 * 60));
        broadcastMaintenanceStatus();
        
        await logMaintenanceAuditEvent('MAINTENANCE_MODE_DISABLED_AUTO', {
          duration: durationMinutes,
          durationFormatted: durationMinutes > 60 
            ? `${Math.round(durationMinutes / 60)}h ${durationMinutes % 60}m` 
            : `${durationMinutes} minutes`,
          startTime: new Date(maintenanceState.startTime).toISOString(),
          endTime: new Date(now).toISOString(),
          message: maintenanceState.message,
          reason: 'scheduled_end_time_reached',
        });
      }
      scheduleMaintenanceCheck();
    }, 10000);
  }
  scheduleMaintenanceCheck();
}

startMaintenanceScheduler();

function calculateServerHints(clientIp?: string): ServerHints {
  const connectionCount = clients.size;
  const loadFactor = Math.min(1, connectionCount / MAX_CONNECTIONS);
  
  let health: ServerHints['health'] = 'healthy';
  let recommendedDelay = 1000;
  
  if (maintenanceState.enabled) {
    health = 'degraded';
    recommendedDelay = 10000;
  } else if (loadFactor > 0.9) {
    health = 'overloaded';
    recommendedDelay = 5000;
  } else if (loadFactor > 0.7) {
    health = 'degraded';
    recommendedDelay = 3000;
  } else if (loadFactor > 0.5) {
    recommendedDelay = 2000;
  }
  
  let rateLimitRemaining = 100;
  if (clientIp) {
    const status = getRateLimitStatus(clientIp);
    rateLimitRemaining = Math.round((status.connectionRemaining / status.connectionLimit) * 100);
  }
  
  return {
    health,
    connectionCount,
    maxConnections: MAX_CONNECTIONS,
    loadFactor: Math.round(loadFactor * 100) / 100,
    recommendedDelay,
    maintenanceMode: maintenanceState.enabled,
    rateLimitRemaining,
    serverTime: Date.now(),
  };
}

export function getWss(): WebSocketServer | null {
  return wss;
}

export function getServerHints(): ServerHints {
  return calculateServerHints();
}

export function getMaintenanceState(): MaintenanceState {
  return _getMaintenanceState();
}

export function setMaintenanceMode(
  enabled: boolean,
  message?: string,
  estimatedEnd?: number,
  allowedUsers?: string[],
  scheduledStart?: number | null,
  scheduledEnd?: number | null
): void {
  _setMaintenanceMode(enabled, message, estimatedEnd, allowedUsers, scheduledStart, scheduledEnd);
  broadcastMaintenanceStatus();
}

function broadcastMaintenanceStatus(): void {
  const msg = JSON.stringify({
    type: 'maintenance_status',
    maintenance: {
      enabled: maintenanceState.enabled,
      message: maintenanceState.message,
      estimatedEnd: maintenanceState.estimatedEnd,
    },
  });
  
  wss?.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

export function startWsServer(port: number): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({ port });

  const { getAllowedOrigins } = require('@/config/app-urls');
  const allowedOrigins = new Set(getAllowedOrigins());
  // Dev convenience: any localhost/LAN host on any port may connect (Vite dev
  // servers don't fixed ports — "host:4400", "localhost:5173", etc).
  const devOriginsOk = process.env.NODE_ENV !== 'production';

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(origin)
        || /^https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(origin);
      if (!(devOriginsOk && isLocalOrigin)) {
        ws.close(1008, 'Origin not allowed');
        return;
      }
    }
    
    const clientIp = req.headers['x-forwarded-for'] as string || 
                     req.headers['x-real-ip'] as string ||
                     req.socket.remoteAddress || 'unknown';
    
    const connRateLimit = checkConnectionRateLimit(clientIp);
    if (!connRateLimit.allowed) {
      ws.send(JSON.stringify({
        type: 'rate_limit_exceeded',
        message: 'Too many connection attempts. Please try again later.',
        retryAfter: Math.ceil((connRateLimit.resetAt - Date.now()) / 1000),
      }));
      ws.close(4003, 'Rate limit exceeded');
      return;
    }
    
    if (maintenanceState.enabled) {
      ws.send(JSON.stringify({
        type: 'maintenance_status',
        maintenance: {
          enabled: true,
          message: maintenanceState.message,
          estimatedEnd: maintenanceState.estimatedEnd,
        },
      }));
      ws.close(4002, 'Server in maintenance mode');
      return;
    }
    
    const clientId = crypto.randomUUID();
    let userId: string | undefined = undefined;
    let email: string = 'unknown';
    let authenticated = false;

    // ── Cookie auto-auth: same-origin browser clients (CDN app via the Vite
    // proxy) send the httpOnly __session cookie on the upgrade request.
    // Authenticate straight away so apps don't need to hold a raw token.
    try {
      const cookieHeader = (req.headers.cookie || '') as string;
      const match = cookieHeader.match(/(?:^|;\s*)__session=([^;]+)/);
      if (match) {
        const session = await getSessionFromToken(decodeURIComponent(match[1]));
        if (session?.userId) {
          userId = session.userId;
          email = session.email ?? 'unknown';
          authenticated = true;
          const adminRole = (session as any).adminRole;
          clients.set(clientId, { ws, userId: userId!, email, alive: true, adminRole });
          if (!userConnections.has(userId!)) userConnections.set(userId!, new Set());
          userConnections.get(userId!)!.add(clientId);
          ws.send(JSON.stringify({ type: 'auth_ok', userId: userId!, adminRole }));
        }
      }
    } catch {
      // Cookie auth failed — the client can still send { type: "auth", token }.
    }

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'auth' && msg.token) {
          const session = await getSessionFromToken(msg.token);
          if (!session) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
            return;
          }
          userId = session.userId ?? undefined;
          email = session.email ?? 'unknown';
          authenticated = true;

          const adminRole = (session as any).adminRole;
          clients.set(clientId, { ws, userId: userId!, email, alive: true, adminRole });
          if (!userConnections.has(userId!)) userConnections.set(userId!, new Set());
          userConnections.get(userId!)!.add(clientId);

          ws.send(JSON.stringify({ type: 'auth_ok', userId: userId!, adminRole }));
          return;
        }

        if (msg.type === 'pong') {
          const client = clients.get(clientId);
          if (client) client.alive = true;
          return;
        }

        if (msg.type !== 'pong' && msg.type !== 'auth') {
          const client = clients.get(clientId);
          const isAdmin = client?.adminRole && ['admin', 'super_admin'].includes(client.adminRole);
          
          if (!isAdmin) {
            const msgRateLimit = checkMessageRateLimit(clientId);
            if (!msgRateLimit.allowed) {
              ws.send(JSON.stringify({
                type: 'rate_limit_exceeded',
                message: 'Message rate limit exceeded. Please slow down.',
                retryAfter: Math.ceil((msgRateLimit.resetAt - Date.now()) / 1000),
                remaining: msgRateLimit.remaining,
              }));
              return;
            }
          }
        }

        if (msg.type === 'get_hints') {
          const hints = calculateServerHints(clientIp);
          ws.send(JSON.stringify({ type: 'server_hints', hints }));
          return;
        }

        if (msg.type === 'get_maintenance') {
          ws.send(JSON.stringify({
            type: 'maintenance_status',
            maintenance: {
              enabled: maintenanceState.enabled,
              message: maintenanceState.message,
              estimatedEnd: maintenanceState.estimatedEnd,
            },
          }));
          return;
        }

        if (!authenticated) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated. Send { type: "auth", token: "..." }' }));
          return;
        }

        if (msg.type === 'typing_start' || msg.type === 'typing_stop') {
          if (msg.ticketId && msg.recipientId) {
            try {
              sendToUser(msg.recipientId, {
                type: msg.type,
                ticketId: msg.ticketId,
                userId,
                userName: email?.split('@')[0] || 'User',
              });
            } catch {}
          }
          return;
        }

        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (msg.type === 'subscribe' && typeof msg.channel === 'string') {
          const client = clients.get(clientId);
          const isAdmin = client?.adminRole && ['admin', 'super_admin'].includes(client.adminRole);
          const isOwnUserChannel = msg.channel.startsWith('user:') && msg.channel === `user:${userId}`;
          if (msg.channel === 'admin' && !isAdmin) {
            ws.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'Admin channel requires an admin role' }));
            return;
          }
          if (msg.channel.startsWith('user:') && !isOwnUserChannel && !isAdmin) {
            ws.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'You can only subscribe to your own user channel' }));
            return;
          }
          let set = channelSubs.get(msg.channel);
          if (!set) {
            set = new Set();
            channelSubs.set(msg.channel, set);
          }
          set.add(clientId);
          ws.send(JSON.stringify({ type: 'subscribed', channel: msg.channel }));
          return;
        }

        if (msg.type === 'unsubscribe' && typeof msg.channel === 'string') {
          const set = channelSubs.get(msg.channel);
          if (set) {
            set.delete(clientId);
            if (set.size === 0) channelSubs.delete(msg.channel);
          }
          ws.send(JSON.stringify({ type: 'unsubscribed', channel: msg.channel }));
          return;
        }

        if (msg.type === 'publish' && typeof msg.channel === 'string' && msg.event) {
          const client = clients.get(clientId);
          const isAdmin = client?.adminRole && ['admin', 'super_admin'].includes(client.adminRole);
          if (!isAdmin && !msg.channel.startsWith('user:')) {
            ws.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'Publish not allowed on this channel' }));
            return;
          }
          sendToChannel(msg.channel, msg.event, clientId);
          return;
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
      }
    });

    ws.on('close', () => {
      const client = clients.get(clientId);
      if (client?.userId) {
        lastSeenTimes.set(client.userId, Date.now());
        const conns = userConnections.get(client.userId);
        if (conns) {
          conns.delete(clientId);
          if (conns.size === 0) userConnections.delete(client.userId);
        }
      }
      for (const [channel, set] of channelSubs) {
        if (set.delete(clientId) && set.size === 0) channelSubs.delete(channel);
      }
      clients.delete(clientId);
    });

    ws.on('error', () => {
      clients.delete(clientId);
    });

    setTimeout(() => {
      if (!authenticated) {
        ws.close(4001, 'Authentication timeout');
        clients.delete(clientId);
      }
    }, 5000);
  });

  const interval = setInterval(() => {
    const now = Date.now();
    
    cleanupRateLimits();
    
    const hints = calculateServerHints();
    
    wss?.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
        
        if (now - lastHintsBroadcast >= HINTS_BROADCAST_INTERVAL) {
          ws.send(JSON.stringify({ type: 'server_hints', hints }));
        }
      }
    });
    
    if (now - lastHintsBroadcast >= HINTS_BROADCAST_INTERVAL) {
      lastHintsBroadcast = now;
    }
  }, 30000);

  wss.on('close', () => clearInterval(interval));

  console.log(`WebSocket server started on ws://0.0.0.0:${port}`);
  return wss;
}

export function sendToUser(userId: string, data: unknown) {
  const conns = userConnections.get(userId);
  if (!conns) return;

  const msg = JSON.stringify(data);
  for (const clientId of conns) {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  }

  // Mirror into the realtime platform (wss://ws.tirbeo.app/ws) via shared Redis.
  const evt = data && typeof data === 'object' ? (data as Record<string, unknown>) : { type: 'message', payload: data };
  publishToRealtime(
    { userId },
    {
      type: typeof evt.type === 'string' ? evt.type : 'message',
      actor: evt.actor as { id: string; email?: string } | undefined,
      payload: evt,
    },
  );
}

export function broadcast(data: unknown) {
  const msg = JSON.stringify(data);
  wss?.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });

  const evt = data && typeof data === 'object' ? (data as Record<string, unknown>) : { type: 'broadcast', payload: data };
  publishToRealtime(
    { broadcast: true },
    {
      type: typeof evt.type === 'string' ? evt.type : 'broadcast',
      actor: evt.actor as { id: string; email?: string } | undefined,
      payload: evt,
    },
  );
}

export function getOnlineUserIds(): string[] {
  return Array.from(userConnections.keys());
}

/** Number of live WS clients on this process (for the CDN control plane). */
export function getWsClientCount(): number {
  return clients.size;
}

/** Connected clients per channel — channel name → client count. */
export function getWsChannelCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [channel, set] of channelSubs) {
    if (set.size > 0) out[channel] = set.size;
  }
  return out;
}

/**
 * Deliver a realtime event to every client subscribed to a channel
 * (local protocol parity with the realtime platform), and mirror it into
 * wss://ws.tirbeo.app/ws via shared Redis.
 */
export function sendToChannel(channel: string, data: unknown, excludeClientId?: string) {
  const set = channelSubs.get(channel);
  if (set && set.size > 0) {
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>) : { type: 'message', payload: data };
    const event = {
      id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
      type: typeof raw.type === 'string' ? raw.type : 'message',
      channel,
      payload: raw,
      timestamp: new Date().toISOString(),
    };
    const msg = JSON.stringify({ type: 'event', channel, event });
    for (const clientId of set) {
      if (clientId === excludeClientId) continue;
      const client = clients.get(clientId);
      if (client && client.ws.readyState === WebSocket.OPEN) client.ws.send(msg);
    }
  }
  const evt = data && typeof data === 'object' ? (data as Record<string, unknown>) : { type: 'message', payload: data };
  publishToRealtime(
    { channel },
    {
      type: typeof evt.type === 'string' ? evt.type : 'message',
      actor: evt.actor as { id: string; email?: string } | undefined,
      payload: evt,
    },
  );
}

export function getLastSeen(userId: string): number | null {
  if (userConnections.has(userId)) return 0;
  return lastSeenTimes.get(userId) || null;
}

export function getLastSeenMap(userIds: string[]): Record<string, { online: boolean; lastSeen: number | null }> {
  const result: Record<string, { online: boolean; lastSeen: number | null }> = {};
  for (const id of userIds) {
    const isOnline = userConnections.has(id);
    result[id] = {
      online: isOnline,
      lastSeen: isOnline ? 0 : (lastSeenTimes.get(id) || null),
    };
  }
  return result;
}


