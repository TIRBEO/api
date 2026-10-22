import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSessionOrResponse } from '@/features/auth/http-guards';
import { isRoleKey, LEGACY_ROLE, ROLES, resolveStaff } from '@/features/auth/roles';

/* GET /api/admin/me — who is holding the console, and what they may open.
 *
 * The console gates its whole layout on this answer, so it carries three things
 * and not one: the identity (a name to greet and an id to attribute writes to),
 * the role as a *label* rather than a rank string to compare, and the resolved
 * permission set the rail is drawn from. A screen that inferred its own rights
 * by checking `adminRole === 'admin'` is how a moderator gets a button that
 * answers 403 — so the booleans come from here, where the catalogue lives. */
export async function GET(request: NextRequest) {
  const session = await getSessionOrResponse(request);
  if (session instanceof NextResponse) return session;

  const staff = await resolveStaff(session.userId);
  if (!staff) {
    return NextResponse.json({ error: 'This account is not staff.' }, { status: 403 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, status: true, profile: { select: { name: true } } },
  });
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const role = isRoleKey(staff.staff.role) ? staff.staff.role : LEGACY_ROLE;
  const definition = ROLES[role];

  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.profile?.name ?? null,
    status: user.status,
    // Kept as a plain string because the audit metadata and the console's own
    // copy both read it; `role` beside it is the richer answer.
    adminRole: role,
    role: {
      key: role,
      label: definition.label,
      purpose: definition.purpose,
      rank: definition.rank,
      assigned: staff.staff.assigned },
    permissions: staff.permissions,
    canManageStaff: role === 'owner',
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
