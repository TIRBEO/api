import { NextResponse } from 'next/server';
import { getSessionFromRequest } from '../../../../lib/auth/session';
import { prisma } from '../../../../lib/db/prisma';
import { cachedJson } from '../../../../lib/response';
import { getEffectivePermissions } from '../../../../lib/roles';

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request as any);
  if (!session) return new NextResponse('Unauthorized', { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, name: true, adminRole: true },
  });
  if (!user || !user.adminRole) return new NextResponse('Forbidden', { status: 403 });

  const permissions = await getEffectivePermissions(user.id);
  const roleAssignments = await prisma.userRole.findMany({
    where: { userId: user.id },
    include: { role: { select: { id: true, name: true, color: true, icon: true } } },
  });

  return cachedJson({
    id: user.id,
    email: user.email,
    name: user.name,
    adminRole: user.adminRole,
    permissions,
    roles: roleAssignments.map(a => a.role),
  });
}
