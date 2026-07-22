import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { getSessionFromToken } from '../auth/session';

interface WsClient {
  ws: WebSocket;
  userId: string;
  email: string;
  alive: boolean;
}

const clients = new Map<string, WsClient>();
const userConnections = new Map<string, Set<string>>();

let wss: WebSocketServer | null = null;

export function getWss(): WebSocketServer | null {
  return wss;
}

export function startWsServer(port: number): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({ port });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const clientId = crypto.randomUUID();
    let userId: string | null = null;
    let email: string = 'unknown';
    let authenticated = false;

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'auth' && msg.token) {
          const session = await getSessionFromToken(msg.token);
          if (!session) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
            return;
          }
          userId = session.userId;
          email = session.email;
          authenticated = true;

          clients.set(clientId, { ws, userId, email, alive: true });
          if (!userConnections.has(userId)) userConnections.set(userId, new Set());
          userConnections.get(userId)!.add(clientId);

          ws.send(JSON.stringify({ type: 'auth_ok', userId }));
          return;
        }

        if (msg.type === 'pong') {
          const client = clients.get(clientId);
          if (client) client.alive = true;
          return;
        }

        if (!authenticated) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated. Send { type: "auth", token: "..." }' }));
          return;
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
      }
    });

    ws.on('close', () => {
      const client = clients.get(clientId);
      if (client?.userId) {
        const conns = userConnections.get(client.userId);
        if (conns) {
          conns.delete(clientId);
          if (conns.size === 0) userConnections.delete(client.userId);
        }
      }
      clients.delete(clientId);
    });

    ws.on('error', () => {
      clients.delete(clientId);
    });

    // Give client 5s to authenticate before closing
    setTimeout(() => {
      if (!authenticated) {
        ws.close(4001, 'Authentication timeout');
        clients.delete(clientId);
      }
    }, 5000);
  });

  // Heartbeat ping every 30s
  const interval = setInterval(() => {
    wss?.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    });
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
}

export function broadcast(data: unknown) {
  const msg = JSON.stringify(data);
  wss?.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

export function getOnlineUserIds(): string[] {
  return Array.from(userConnections.keys());
}
