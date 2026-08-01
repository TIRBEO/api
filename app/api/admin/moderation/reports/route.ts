import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../lib/session';
import { listReports } from '../../../../../lib/moderation';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const sp = request.nextUrl.searchParams;
  const result = await listReports({
    limit: Number(sp.get('limit')) || 50,
    offset: Number(sp.get('offset')) || 0,
    status: sp.get('status') || undefined,
    targetType: sp.get('targetType') || undefined,
    reason: sp.get('reason') || undefined,
  });
  return NextResponse.json(result);
}
