import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/features/auth/http-guards';
import { listDevices } from '@/features/admin/devices';

/* /api/admin/devices — every browser the platform is holding.

 * A read of someone else's hardware, so `security.read` and nothing looser: the
 * moderator role that watches the safety ledger gets it, and a support account
 * whose job is to answer a question about an account does not. */
export async function GET(request: NextRequest) {
  const session = await requirePermission(request, 'security.read');
  if (session instanceof NextResponse) return session;

  const p = request.nextUrl.searchParams;
  const { rows, total, page, limit } = await listDevices({
    page: Number(p.get('page')) || 1,
    limit: Number(p.get('limit')) || 50,
    q: p.get('q') || undefined,
    userId: p.get('userId') || undefined,
    status: p.get('status') || undefined,
  });

  return NextResponse.json({ rows, total, page, limit }, { headers: { 'Cache-Control': 'private, no-store' } });
}
