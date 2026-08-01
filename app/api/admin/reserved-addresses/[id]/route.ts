import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/db/prisma';
import { requireAdmin } from '../../../../../lib/session';

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  await prisma.reservedAddress.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
