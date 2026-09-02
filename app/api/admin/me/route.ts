import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { prisma } from '../../../../lib/db/prisma';
import { cachedJson } from '../../../../lib/response';
import { getEffectivePermissions } from '../../../../lib/roles';

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request as any);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, name: true, adminRole: true },
  });
  if (!user || !user.adminRole) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const permissions = await getEffectivePermissions(user.id);

  return cachedJson({
    id: user.id,
    email: user.email,
    name: user.name,
    adminRole: user.adminRole,
    permissions,
    roles: [],
  });
}
