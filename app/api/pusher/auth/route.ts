// POST /api/pusher/auth — Pusher Channels private-channel authentication.
//
// The pusher-js client calls this when subscribing to `private-user-<id>`.
// We verify the cookie session server-side and ONLY authorize the channel
// that belongs to the authenticated user — a user can never subscribe to
// another user's channel.
//
// The client may be connected to any of the 5 regional Channels apps, so the
// request carries the app name and we sign with that app's credentials.
//
// CORS: the accounts frontend (accounts.tirbeo.app / localhost:3002) calls
// this cross-origin with `credentials: 'include'`, so the same-origin allow
// list from lib/response.ts is applied here (including the OPTIONS preflight
// pusher-js issues for its XHR auth transport).
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { pusherAuthorizeChannel, getPusherApps } from '@tirbeo/pusher';

export const runtime = 'nodejs';

const ALLOWED_ORIGINS = ['localhost', '127.0.0.1', 'api-tirbeo.vercel.app'];

function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get('origin') || '';
  if (!origin) return {};
  try {
    const u = new URL(origin);
    if (ALLOWED_ORIGINS.includes(u.hostname) || u.hostname.endsWith('.tirbeo.app')) {
      return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Credentials': 'true',
      };
    }
  } catch {}
  return {};
}

export async function OPTIONS(request: NextRequest) {
  const headers = corsHeaders(request);
  if (!headers['Access-Control-Allow-Origin']) {
    return new NextResponse(null, { status: 204 });
  }
  return new NextResponse(null, { status: 204, headers });
}

export async function POST(request: NextRequest) {
  const headers = corsHeaders(request);
  try {
    const session = await requireSession(request);
    if (session instanceof NextResponse) {
      // Attach CORS even to auth failures so the client sees the real status
      // instead of an opaque CORS error.
      for (const [k, v] of Object.entries(headers)) session.headers.set(k, v);
      return session;
    }

    const form = await request.formData();
    const socketId = String(form.get('socket_id') || '');
    const channel = String(form.get('channel_name') || '');
    const appParam = String(form.get('app') || 'primary');

    if (!socketId || !channel) {
      return NextResponse.json({ error: 'socket_id and channel_name required' }, { status: 400, headers });
    }

    // ── Authorization: users may only subscribe to their own channel ──
    const OWN_CHANNEL = `private-user-${session.userId}`;
    const PUBLIC_CHANNELS = ['announcements'];
    if (channel !== OWN_CHANNEL && !PUBLIC_CHANNELS.includes(channel)) {
      return NextResponse.json({ error: 'Forbidden channel' }, { status: 403, headers });
    }

    // Sign with the credentials of the app the client is connected to.
    const app = getPusherApps().find((a) => a.name === appParam);
    if (!app) {
      return NextResponse.json({ error: 'Unknown app' }, { status: 400, headers });
    }

    const { auth } = pusherAuthorizeChannel(socketId, channel, app, {
      user_id: session.userId,
    });
    return NextResponse.json({ auth }, { headers });
  } catch (err: any) {
    console.error('[PUSHER/AUTH]', err?.message || err);
    return NextResponse.json({ error: 'Auth failed' }, { status: 500, headers });
  }
}
