import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/features/auth/http-guards';
import { listPush } from '@/features/admin/devices';

/* /api/admin/push — the device subscriptions the platform may wake.

 * What this answers is "how many boxes can we ring, and which stopped
 * answering". It deliberately cannot answer "give me a subscription's address":
 * a push endpoint URL is a bearer token, so the route hands back the provider's
 * host name and the fact that keys exist, and nothing downstream can render the
 * credential by forgetting to truncate it. */
export async function GET(request: NextRequest) {
  const session = await requirePermission(request, 'security.read');
  if (session instanceof NextResponse) return session;

  const p = request.nextUrl.searchParams;
  const { rows, total, page, limit } = await listPush({
    page: Number(p.get('page')) || 1,
    limit: Number(p.get('limit')) || 50,
    q: p.get('q') || undefined,
    userId: p.get('userId') || undefined,
  });

  return NextResponse.json({ rows, total, page, limit }, { headers: { 'Cache-Control': 'private, no-store' } });
}
