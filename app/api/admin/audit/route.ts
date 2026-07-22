import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/session';
import { listAuditEvents, createAuditEvent } from '../../../../lib/audit';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const sp = request.nextUrl.searchParams;
  const result = await listAuditEvents({
    limit: Number(sp.get('limit')) || 50,
    offset: Number(sp.get('offset')) || 0,
    action: sp.get('action') || undefined,
    actorId: sp.get('actorId') || undefined,
    targetType: sp.get('targetType') || undefined,
    severity: sp.get('severity') || undefined,
    from: sp.get('from') || undefined,
    to: sp.get('to') || undefined,
  });
  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  await createAuditEvent({
    actorId: session.userId,
    action: body.action,
    targetType: body.targetType,
    targetId: body.targetId,
    metadata: body.metadata,
    severity: body.severity,
  });
  return NextResponse.json({ ok: true });
}
