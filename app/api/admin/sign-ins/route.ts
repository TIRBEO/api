import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/features/auth/http-guards';
import { listSignIns } from '@/features/admin/devices';

/* /api/admin/sign-ins — the record of who knocked on the door, how, and
 * whether it opened.
 *
 * Two screens read this: the dashboard's sign-in panel (which asks for the last
 * few days and the per-method split) and Reporting → Sign-in (which asks for a
 * page of rows under a filter). They get the same response, because a number
 * that means one thing on one screen and another thing on the next is the bug
 * the product rules name explicitly.
 *
 * `from` and `to` are ISO dates. A value that does not parse becomes an invalid
 * Date and Prisma answers with an error rather than quietly widening the window
 * to everything — so the route parses first and refuses, which is the honest
 * answer to a filter nobody applied. */
export async function GET(request: NextRequest) {
  const session = await requirePermission(request, 'security.read');
  if (session instanceof NextResponse) return session;

  const p = request.nextUrl.searchParams;
  const range: { from?: string; to?: string } = {};
  for (const key of ['from', 'to'] as const) {
    const raw = p.get(key);
    if (!raw) continue;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: `${key} must be a date, for example 2026-10-01.` }, { status: 400 });
    }
    range[key] = parsed.toISOString();
  }

  const result = await listSignIns({
    page: Number(p.get('page')) || 1,
    limit: Number(p.get('limit')) || 50,
    q: p.get('q') || undefined,
    userId: p.get('userId') || undefined,
    method: p.get('method') || undefined,
    success: p.get('success') || undefined,
    ...range,
  });

  return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
}
