import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/features/auth/http-guards';
import { listPasskeys } from '@/features/admin/devices';

/* /api/admin/passkeys — which accounts hold a hardware key, and how much those
 * keys have been used.
 *
 * `credential_pubkey` is never in the select. A stored public key is not a
 * secret the way a private key is, but it is not something a screen has a use
 * for either, and a console that prints key material trains people to paste it
 * into the wrong window. The counter is here because it answers the only
 * question that matters about a key nobody has written about: has this ever
 * actually signed anything. */
export async function GET(request: NextRequest) {
  const session = await requirePermission(request, 'security.read');
  if (session instanceof NextResponse) return session;

  const p = request.nextUrl.searchParams;
  const { rows, total, page, limit } = await listPasskeys({
    page: Number(p.get('page')) || 1,
    limit: Number(p.get('limit')) || 50,
    q: p.get('q') || undefined,
    userId: p.get('userId') || undefined,
  });

  return NextResponse.json({ rows, total, page, limit }, { headers: { 'Cache-Control': 'private, no-store' } });
}
