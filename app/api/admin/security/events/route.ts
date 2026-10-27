import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/features/auth/http-guards';
import { listSecurityEvents, getSecurityStats } from '@/features/security/security';

/** How far back a purge is allowed to reach, in days. */
const PURGE_MIN_DAYS = 7;

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, 'security.read');
  if (session instanceof NextResponse) return session;

  const url = request.nextUrl;
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);
  const id = url.searchParams.get('id') || undefined;
  const eventType = url.searchParams.get('eventType') || undefined;
  const severity = url.searchParams.get('severity') || undefined;
  const ip = url.searchParams.get('ip') || undefined;
  const userId = url.searchParams.get('userId') || undefined;
  const q = url.searchParams.get('q') || undefined;
  const from = url.searchParams.get('from') || undefined;
  const to = url.searchParams.get('to') || undefined;
  const includeUser = url.searchParams.get('includeUser') !== 'false';

  const [data, stats] = await Promise.all([
    listSecurityEvents({ page, limit, id, eventType, severity, ip, userId, q, from, to, includeUser }),
    getSecurityStats(),
  ]);

  return NextResponse.json({ ...data, stats });
}

export async function DELETE(request: NextRequest) {
  // Not `security.read`: reading the ledger is a job a support or analyst
  // account has, and the same permission must not be able to empty it.
  const session = await requirePermission(request, 'security.purge');
  if (session instanceof NextResponse) return session;

  const { prisma } = await import('@/infrastructure/db/prisma');
  const url = request.nextUrl;
  // A zero, a negative or a junk value would otherwise put the cutoff at or
  // beyond *now* and delete every row the platform has — the purge keeps a
  // floor no matter what the caller asked for.
  const asked = Math.floor(Number(url.searchParams.get('olderThanDays')));
  const olderThanDays = Number.isFinite(asked) && asked >= PURGE_MIN_DAYS ? asked : PURGE_MIN_DAYS;
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  // One ledger now: the GET above reads activity_events (listSecurityEvents),
  // so the purge must target the same table. Admin-only endpoint; note the
  // ledger also carries audit rows — the cutoff default (30d) applies to all.
  const result = await prisma.activityEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return NextResponse.json({ deleted: result.count, olderThanDays });
}
