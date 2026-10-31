import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { generateTurnIceServers } from '@/features/realtime/webrtc-credentials';

/* POST /api/webrtc/ice — short-lived ICE servers for a browser RTCPeerConnection.
   Session-gated: TURN bandwidth is metered, so credentials are only ever handed
   to signed-in users, and each response expires on its own (default 1 hour). */

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;

  let ttl = 3600;
  try {
    const body = await request.json();
    if (typeof body?.ttl === 'number') ttl = Math.min(Math.max(body.ttl, 60), 86400);
  } catch { /* body optional */ }

  try {
    const ice = await generateTurnIceServers(ttl);
    return NextResponse.json(ice);
  } catch (err: any) {
    console.error('[WEBRTC/ICE]', err?.message || err);
    return NextResponse.json({ error: 'Could not mint ICE credentials' }, { status: 502 });
  }
}
