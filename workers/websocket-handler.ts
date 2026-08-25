/**
 * Cloudflare Workers WebSocket Pub/Sub Relay
 *
 * Deploy with: pnpm wrangler deploy --env=""
 *
 * Routes:
 *   GET  /health              — Health check
 *   GET  /ws or /ws/          — WebSocket upgrade
 *   POST /api/publish         — Accept events from the API server (Bearer auth)
 *
 * WebSocket protocol:
 *   Client → Server: { type: "auth", token: "..." }
 *   Server → Client: { type: "auth_ok", userId: "...", adminRole: "..." }
 *   Client → Server: { type: "subscribe", channel: "user:{userId}" | "admin" }
 *   Client → Server: { type: "ping" }
 *   Server → Client: { type: "pong" }
 *   Server → Client: { type: "event", channel: "...", event: { ... } }
 *   Server → Client: { type: "notification", data: { ... } }
 */

interface Env {
  // Cloudflare Workers don't use env for in-memory state,
  // but we declare it for type safety.
}

// ─── In-memory connection tracking ───────────────────────────────
// Maps are per-isolate. For moderate traffic this is fine; for massive
// scale, migrate to Durable Objects or D1.

interface WsClient {
  ws: WebSocket;
  userId: string | null;
  email: string;
  adminRole: string | null;
  channels: Set<string>;
  connectedAt: number;
}

// Use globalThis to survive hot reloads in dev
const g = globalThis as any;
if (!g.__cfClients) g.__cfClients = new Map<string, WsClient>();
if (!g.__cfUserIds) g.__cfUserIds = new Map<string, Set<string>>(); // userId → Set<clientId>
if (!g.__cfChannels) g.__cfChannels = new Map<string, Set<string>>(); // channel → Set<clientId>

const clients: Map<string, WsClient> = g.__cfClients;
const userConnections: Map<string, Set<string>> = g.__cfUserIds;
const channelSubs: Map<string, Set<string>> = g.__cfChannels;

// ─── Auth ────────────────────────────────────────────────────────

async function verifyToken(token: string): Promise<{ userId: string; email: string; adminRole?: string } | null> {
  try {
    const res = await fetch('https://api.tirbeo.app/api/auth/verify', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (data?.userId) return { userId: data.userId, email: data.email || '', adminRole: data.adminRole };
    return null;
  } catch {
    return null;
  }
}

// ─── Routing ─────────────────────────────────────────────────────

function routeToUser(userId: string, event: Record<string, unknown>): void {
  const connIds = userConnections.get(userId);
  if (!connIds) return;
  const raw = JSON.stringify({ type: 'event', channel: `user:${userId}`, event });
  for (const cid of connIds) {
    const client = clients.get(cid);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      try { client.ws.send(raw); } catch {}
    }
  }
}

function routeToChannel(channel: string, event: Record<string, unknown>): void {
  const connIds = channelSubs.get(channel);
  if (!connIds) return;
  const raw = JSON.stringify({ type: 'event', channel, event });
  for (const cid of connIds) {
    const client = clients.get(cid);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      try { client.ws.send(raw); } catch {}
    }
  }
}

function routeBroadcast(event: Record<string, unknown>): void {
  const raw = JSON.stringify({ type: 'event', channel: 'broadcast', event });
  for (const [, client] of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      try { client.ws.send(raw); } catch {}
    }
  }
}

// ─── Connection management ──────────────────────────────────────

function addClient(clientId: string, ws: WebSocket): void {
  clients.set(clientId, { ws, userId: null, email: '', adminRole: null, channels: new Set(), connectedAt: Date.now() });
}

function removeClient(clientId: string): void {
  const client = clients.get(clientId);
  if (!client) return;
  // Remove from user map
  if (client.userId) {
    const set = userConnections.get(client.userId);
    if (set) { set.delete(clientId); if (set.size === 0) userConnections.delete(client.userId); }
  }
  // Remove from channel map
  for (const ch of client.channels) {
    const set = channelSubs.get(ch);
    if (set) { set.delete(clientId); if (set.size === 0) channelSubs.delete(ch); }
  }
  clients.delete(clientId);
}

function authenticateClient(clientId: string, userId: string, email: string, adminRole?: string): void {
  const client = clients.get(clientId);
  if (!client) return;
  client.userId = userId;
  client.email = email;
  client.adminRole = adminRole || null;
  if (!userConnections.has(userId)) userConnections.set(userId, new Set());
  userConnections.get(userId)!.add(clientId);
  // Auto-subscribe to own user channel
  client.channels.add(`user:${userId}`);
  if (!channelSubs.has(`user:${userId}`)) channelSubs.set(`user:${userId}`, new Set());
  channelSubs.get(`user:${userId}`)!.add(clientId);
  // Auto-subscribe to admin channel if admin
  if (adminRole && ['admin', 'super_admin'].includes(adminRole)) {
    client.channels.add('admin');
    if (!channelSubs.has('admin')) channelSubs.set('admin', new Set());
    channelSubs.get('admin')!.add(clientId);
  }
}

// ─── CORS helpers ────────────────────────────────────────────────

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ─── Main handler ────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ─── Health check ─────────────────────────────────────────
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      return json({
        status: 'ok',
        service: 'tirbeo-realtime-worker',
        protocol: '1.0.0',
        connections: clients.size,
        authenticated: Array.from(clients.values()).filter(c => c.userId).length,
        channels: channelSubs.size,
        time: new Date().toISOString(),
      });
    }

    // ─── Publish endpoint (API server → Worker) ──────────────
    if (url.pathname === '/api/publish' && request.method === 'POST') {
      const authHeader = request.headers.get('authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const expectedToken = (env as any).RT_API_TOKEN || '';
      if (!expectedToken || token !== expectedToken) {
        return json({ error: 'Unauthorized' }, 401);
      }

      try {
        const body: any = await request.json();
        const event = body.event as Record<string, unknown>;
        if (!event) return json({ error: 'Missing event' }, 400);

        // Route based on target
        if (body.userId) {
          routeToUser(body.userId, event);
        } else if (body.channel) {
          routeToChannel(body.channel, event);
        } else if (body.broadcast) {
          routeBroadcast(event);
        } else {
          return json({ error: 'Missing target (userId, channel, or broadcast)' }, 400);
        }

        return json({ ok: true, delivered: clients.size > 0 });
      } catch {
        return json({ error: 'Invalid request body' }, 400);
      }
    }

    // ─── WebSocket upgrade ────────────────────────────────────
    if (url.pathname === '/ws' || url.pathname.startsWith('/ws/')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({
          message: 'WebSocket endpoint',
          connect: `wss://${url.host}/ws`,
        });
      }

      const pair = new WebSocketPair();
      const [clientWs, serverWs] = [pair[0], pair[1]];
      serverWs.accept();

      const clientId = crypto.randomUUID();
      addClient(clientId, serverWs);

      // Auth timeout: 10 seconds
      const authTimeout = setTimeout(() => {
        const c = clients.get(clientId);
        if (c && !c.userId) {
          try { serverWs.close(4001, 'Authentication timeout'); } catch {}
          removeClient(clientId);
        }
      }, 10_000);

      serverWs.addEventListener('message', async (event) => {
        try {
          const data = JSON.parse(String(event.data));

          // ─── Auth ──────────────────────────────────────────
          if (data.type === 'auth' && data.token) {
            const user = await verifyToken(data.token);
            if (!user) {
              try { serverWs.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' })); } catch {}
              return;
            }
            clearTimeout(authTimeout);
            authenticateClient(clientId, user.userId, user.email, user.adminRole);
            try {
              serverWs.send(JSON.stringify({
                type: 'auth_ok',
                userId: user.userId,
                adminRole: user.adminRole || null,
              }));
            } catch {}
            return;
          }

          // Require auth for everything else
          const client = clients.get(clientId);
          if (!client?.userId) {
            try { serverWs.send(JSON.stringify({ type: 'error', message: 'Not authenticated. Send { type: "auth", token: "..." }' })); } catch {}
            return;
          }

          // ─── Ping / Pong ───────────────────────────────────
          if (data.type === 'ping') {
            try { serverWs.send(JSON.stringify({ type: 'pong', timestamp: Date.now() })); } catch {}
            return;
          }

          // ─── Subscribe ─────────────────────────────────────
          if (data.type === 'subscribe' && typeof data.channel === 'string') {
            const ch = data.channel;
            // Only allow subscribing to own user channel, admin channel, or broadcast
            const isOwn = ch === `user:${client.userId}`;
            const isAdmin = client.adminRole && ['admin', 'super_admin'].includes(client.adminRole);
            if (ch === 'admin' && !isAdmin) {
              try { serverWs.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'Admin channel requires admin role' })); } catch {}
              return;
            }
            if (ch.startsWith('user:') && !isOwn && !isAdmin) {
              try { serverWs.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'You can only subscribe to your own user channel' })); } catch {}
              return;
            }
            client.channels.add(ch);
            if (!channelSubs.has(ch)) channelSubs.set(ch, new Set());
            channelSubs.get(ch)!.add(clientId);
            try { serverWs.send(JSON.stringify({ type: 'subscribed', channel: ch })); } catch {}
            return;
          }

          // ─── Unsubscribe ───────────────────────────────────
          if (data.type === 'unsubscribe' && typeof data.channel === 'string') {
            client.channels.delete(data.channel);
            const set = channelSubs.get(data.channel);
            if (set) { set.delete(clientId); if (set.size === 0) channelSubs.delete(data.channel); }
            try { serverWs.send(JSON.stringify({ type: 'unsubscribed', channel: data.channel })); } catch {}
            return;
          }

          // ─── Publish to channel (admins only) ──────────────
          if (data.type === 'publish' && typeof data.channel === 'string' && data.event) {
            const isAdmin = client.adminRole && ['admin', 'super_admin'].includes(client.adminRole);
            if (!isAdmin) {
              try { serverWs.send(JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'Publish not allowed' })); } catch {}
              return;
            }
            routeToChannel(data.channel, data.event as Record<string, unknown>);
            return;
          }

          // ─── Typing indicators ─────────────────────────────
          if (data.type === 'typing_start' || data.type === 'typing_stop') {
            if (data.recipientId) {
              routeToUser(data.recipientId, {
                type: data.type,
                ticketId: data.ticketId,
                userId: client.userId,
                userName: client.email.split('@')[0],
              });
            }
            return;
          }

          // Unknown message type — ignore
        } catch {
          try { serverWs.send(JSON.stringify({ type: 'error', message: 'Invalid message' })); } catch {}
        }
      });

      serverWs.addEventListener('close', () => {
        clearTimeout(authTimeout);
        removeClient(clientId);
      });

      serverWs.addEventListener('error', () => {
        clearTimeout(authTimeout);
        removeClient(clientId);
      });

      return new Response(null, { status: 101, webSocket: clientWs });
    }

    // ─── Status endpoint ──────────────────────────────────────
    if (url.pathname === '/api/status' || url.pathname === '/status') {
      return json({
        service: 'tirbeo-realtime-worker',
        version: '2.0.0',
        connections: clients.size,
        authenticated: Array.from(clients.values()).filter(c => c.userId).length,
        channels: channelSubs.size,
        uptime: 'check /health for details',
      });
    }

    return json({ message: 'Tirbeo Realtime Platform', version: '2.0.0' });
  },
};
