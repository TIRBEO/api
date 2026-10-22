import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/features/auth/http-guards';
import { unblockTarget } from '@/features/security/security';
import { createAuditEvent } from '@/features/security/audit';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ targetType: string; targetId: string }> }) {
  const session = await requirePermission(request, 'blocklist.manage');
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
