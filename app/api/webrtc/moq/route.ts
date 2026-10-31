import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { getMoqConfig, moqConfigured } from '@/features/realtime/moq';

/* GET /api/webrtc/moq — MoQ relay endpoint + tokens for a signed-in session.
   Publish tokens go to broadcasters only when we gate who may broadcast;
   today every authenticated account may watch, and publishing is limited to
   the operator token until per-user relay namespaces exist. */

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof NextResponse) return session;
  if (!moqConfigured()) {
    return NextResponse.json({ enabled: false });
  }
  const cfg = getMoqConfig()!;
  return NextResponse.json({
    enabled: true,
    endpoint: cfg.endpoint,
    // Subscribing is safe to hand out broadly; publishing stays server-side
    // until broadcast authorization exists.
    subscribeToken: cfg.subscribeToken,
  });
}
