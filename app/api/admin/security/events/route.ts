import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '../../../../../lib/session';
import { listSecurityEvents, getSecurityStats } from '../../../../../lib/security';

export async function GET(request: NextRequest) {
  const session = await requireRole(request, 'manager');
  if (session instanceof NextResponse) return session;

  const url = request.nextUrl;
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);
  const eventType = url.searchParams.get('eventType') || undefined;
  const severity = url.searchParams.get('severity') || undefined;
  const ip = url.searchParams.get('ip') || undefined;
  const userId = url.searchParams.get('userId') || undefined;
  const from = url.searchParams.get('from') || undefined;
  const to = url.searchParams.get('to') || undefined;

  const [data, stats] = await Promise.all([
    listSecurityEvents({ page, limit, eventType, severity, ip, userId, from, to }),
    getSecurityStats(),
  ]);

  return NextResponse.json({ ...data, stats });
}

export async function DELETE(request: NextRequest) {
  const session = await requireRole(request, 'admin');
  if (session instanceof NextResponse) return session;

  const { prisma } = await import('../../../../../lib/db/prisma');
  const url = request.nextUrl;
  const olderThanDays = Number(url.searchParams.get('olderThanDays')) || 30;
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const result = await prisma.securityEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return NextResponse.json({ deleted: result.count });
}
