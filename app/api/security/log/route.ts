import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { logSecurityEvent, getClientIp, getRayId } from '../../../../lib/security';
import { checkRateLimit } from '../../../../lib/auth/rate-limit';

export const runtime = 'nodejs';

function hasValidKey(request: NextRequest): boolean {
  const key = process.env.SECURITY_LOG_KEY;
  if (!key) return false;
  const header = request.headers.get('x-security-log-key');
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!hasValidKey(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const ip = getClientIp(request);
  const rateOk = await checkRateLimit(`security-log:${ip}`, false);
  if (!rateOk) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  let body: {
    eventType?: string;
    severity?: 'info' | 'warning' | 'error' | 'critical';
    userId?: string | null;
    details?: Record<string, unknown>;
    notifyAdmin?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body?.eventType) {
    return NextResponse.json({ error: 'eventType required' }, { status: 400 });
  }

  const rayId = getRayId(request);
  await logSecurityEvent({
    request,
    userId: body.userId || null,
    eventType: String(body.eventType),
    severity: body.severity || 'warning',
    details: { ...(body.details || {}), rayId: rayId || body.details?.rayId },
    notifyAdmin: body.notifyAdmin !== false,
  });

  return NextResponse.json({ ok: true });
}
