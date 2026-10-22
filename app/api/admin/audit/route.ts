import { NextResponse } from 'next/server';
import { withPermission } from '@/features/auth/permission-guard';
import { listAuditEvents } from '@/features/security/audit';

/* GET /api/admin/audit — the console's read of the trail.
 *
 * There is no POST here on purpose. An audit row is a record of something the
 * platform did, written by the code that did it; a door that accepts
 * `{action, actorId, targetId}` from the network would let any session put
 * anything on behalf of any account, which is the one property this table
 * exists to have. */
export const GET = withPermission('activity.read', async (request) => {
  const sp = request.nextUrl.searchParams;
  const result = await listAuditEvents({
    limit: Number(sp.get('limit')) || 50,
    offset: Number(sp.get('offset')) || 0,
    id: sp.get('id') || undefined,
    action: sp.get('action') || undefined,
    actorId: sp.get('actorId') || undefined,
    targetType: sp.get('targetType') || undefined,
    severity: sp.get('severity') || undefined,
    from: sp.get('from') || undefined,
    to: sp.get('to') || undefined });
  return NextResponse.json(result);
});
