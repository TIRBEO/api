import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../../lib/session';
import { getReportStats } from '../../../../../lib/moderation';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const stats = await getReportStats();
  return NextResponse.json(stats);
}
