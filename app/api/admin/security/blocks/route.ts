import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '../../../../../lib/session';
import { listBlocks, blockTarget, getSecurityStats } from '../../../../../lib/security';
import { createAuditEvent } from '../../../../../lib/audit';

export async function GET(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const url = request.nextUrl;
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(100, Number(url.searchParams.get('limit')) || 50);
  const targetType = url.searchParams.get('targetType') || undefined;
  const activeOnly = url.searchParams.get('activeOnly') !== 'false';
  const search = url.searchParams.get('q') || undefined;

  const data = await listBlocks({ page, limit, targetType, activeOnly, search });
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  let body: {
    targetType?: 'ip' | 'user' | 'email';
    targetId?: string;
    reason?: string;
    hours?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const targetType = body.targetType;
  const targetId = String(body.targetId || '').trim();
  if (!targetType || !['ip', 'user', 'email'].includes(targetType)) {
    return NextResponse.json({ error: 'targetType must be ip, user, or email' }, { status: 400 });
  }
  if (!targetId || targetId.length > 255) {
    return NextResponse.json({ error: 'targetId is required' }, { status: 400 });
  }

  const reason = String(body.reason || '').slice(0, 500);
  const expiresAt = body.hours
    ? new Date(Date.now() + Number(body.hours) * 60 * 60 * 1000)
    : null;

  await blockTarget({
    targetType,
    targetId,
    reason: reason || 'Blocked by admin',
    blockedBy: session.userId,
    expiresAt,
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'security.block_created',
    targetType: 'blocklist',
    metadata: { targetType, targetId, reason, expiresAt: expiresAt?.toISOString() },
    severity: 'warning',
  });

  const blocks = await listBlocks({ page: 1, limit: 50, activeOnly: true });
  return NextResponse.json({ ok: true, ...blocks }, { status: 201 });
}
