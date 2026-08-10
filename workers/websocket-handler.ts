/**
 * Cloudflare Workers WebSocket Handler
 * Deploy with: pnpm wrangler deploy --env=""
 */

interface Env {}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // CORS
    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // ─── WebSocket Upgrade ───
    if (url.pathname === '/ws' || url.pathname.startsWith('/ws/')) {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response(JSON.stringify({ 
          message: 'WebSocket endpoint', 
          connect: `wss://${url.host}/ws/{roomId}` 
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      
      server.accept();
      
      server.send(JSON.stringify({ 
        type: 'connected', 
        roomId: url.pathname.split('/')[2] || 'default',
        timestamp: Date.now() 
      }));
      
      server.addEventListener('message', async (event) => {
        try {
          const data: any = JSON.parse(String(event.data));
          
          if (data.type === 'ping') {
            server.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            return;
          }
          
          if (data.type === 'auth' && data.token) {
            try {
              const res = await fetch('https://api.tirbeo.app/api/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${data.token}` },
              });
              if (res.ok) {
                const userData: any = await res.json();
                server.send(JSON.stringify({ 
                  type: 'auth_ok', 
                  userId: userData.userId || userData.user?.id 
                }));
              } else {
                server.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
              }
            } catch {
              server.send(JSON.stringify({ type: 'auth_error', message: 'Verification failed' }));
            }
            return;
          }
          
          // Echo for now
          server.send(JSON.stringify({ type: 'echo', message: data.message || data }));
          
        } catch (err) {
          server.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
        }
      });
      
      server.addEventListener('close', () => {});
      server.addEventListener('error', () => {});
      
      return new Response(null, { status: 101, webSocket: client });
    }
    
    // ─── Health check ───
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now(), version: '3.0' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    return new Response('Tirbeo WebSocket Server', { headers: corsHeaders });
  },
};
