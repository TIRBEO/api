import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../../../lib/db/prisma';
import { requireAdmin } from '../../../../../../lib/session';
import { updateReport } from '../../../../../../lib/moderation';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const report = await prisma.contentReport.findUnique({
    where: { id },
    include: {
      reporter: { select: { id: true, email: true, name: true } },
      reviewedBy: { select: { id: true, email: true, name: true } },
    },
  });
  if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(report);
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const body = await request.json();
  const report = await updateReport(id, { ...body, reviewedById: session.userId });
  return NextResponse.json(report);
}
