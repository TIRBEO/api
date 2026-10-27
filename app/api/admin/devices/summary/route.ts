import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/features/auth/http-guards';
import { deviceSummary } from '@/features/admin/devices';

/** /api/admin/devices/summary — the counts the Devices overview is made of.

    One call rather than five pages: "how many of these are live" is a count over
    the whole table, and estimating it from a page of 50 would be the kind of
    number the product rules forbid. Every figure here comes from a COUNT or a
    GROUP BY, so a screen that says 115 devices means the database holds 115. */
export async function GET(request: NextRequest) {
  const session = await requirePermission(request, 'security.read');
  if (session instanceof NextResponse) return session;

  const summary = await deviceSummary();
  return NextResponse.json(summary, { headers: { 'Cache-Control': 'private, no-store' } });
}
