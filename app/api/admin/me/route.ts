import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';
import { getEffectivePermissions } from '@/features/auth/roles';

export async function GET(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, isAdmin: true, profile: { select: { name: true } } },
  });
  if (!user || !user.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const permissions = await getEffectivePermissions(user.id);

  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.profile?.name ?? null,
    adminRole: user.isAdmin ? 'admin' : null,
    permissions,
    roles: [],
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
