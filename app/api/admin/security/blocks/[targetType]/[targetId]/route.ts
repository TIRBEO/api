import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/session';
import { unblockTarget } from '@/lib/security';
import { createAuditEvent } from '@/lib/audit';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ targetType: string; targetId: string }> }) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const { targetType, targetId } = await params;
  const decodedType = decodeURIComponent(targetType);
  const decodedId = decodeURIComponent(targetId);

  await unblockTarget(decodedType, decodedId);

  await createAuditEvent({
    actorId: session.userId,
    action: 'security.block_removed',
    targetType: 'blocklist',
    metadata: { targetType: decodedType, targetId: decodedId },
    severity: 'info',
  });

  return NextResponse.json({ ok: true });
}
