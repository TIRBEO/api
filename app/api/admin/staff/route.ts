import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission, requireOwner } from '@/features/auth/http-guards';
import { grantStaffRole, listStaff, revokeStaffRole, StaffGuardError } from '@/features/auth/staff';
import { ROLE_KEYS, ROLES, roleList, type RoleKey } from '@/features/auth/roles';

/* /api/admin/staff — the roster, and the only door that changes it.
 *
 * The gate is deliberately two questions answered in different places.
 * `staff.read` and `staff.manage` come from the permission catalogue, so an
 * installation can widen a role without a deploy; the owner-only check inside
 * `requireOwner` and `grantStaffRole` does not, because who is allowed to make
 * somebody staff cannot be a value in a database row that an owner can edit.
 * Every grant and revocation is refused or allowed *before* the write, against
 * the counts at that moment, so the platform cannot be left without an owner.
 *
 *   GET    → every staff account, its role, and who assigned it
 *   PUT    → { userId, role, note? }  grant, or change which kind
 *   DELETE → { userId }               remove from the roster entirely */

const grantSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(ROLE_KEYS as [RoleKey, ...RoleKey[]]),
  note: z.string().max(500).nullish(),
});

const targetSchema = z.object({ userId: z.string().min(1) });

function guardError(e: unknown): NextResponse {
  if (e instanceof StaffGuardError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  throw e;
}

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, 'staff.read');
  if (session instanceof NextResponse) return session;

  const staff = await listStaff();
  return NextResponse.json({
    staff,
    // The console draws the picker and the per-role power list from this, so
    // the catalogue is published rather than copied into the front end.
    roles: ROLE_KEYS.map((key) => ({
      key,
      label: ROLES[key].label,
      purpose: ROLES[key].purpose,
      rank: ROLES[key].rank,
      permissions: ROLES[key].permissions })),
    canManage: session.staff.role === 'owner',
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function PUT(request: NextRequest) {
  const session = await requireOwner(request);
  if (session instanceof NextResponse) return session;

  const parsed = grantSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: `userId and role are required. Expected one of: ${roleList()}` }, { status: 400 });
  }

  try {
    const row = await grantStaffRole({
      userId: parsed.data.userId,
      role: parsed.data.role,
      actorId: session.userId,
      note: parsed.data.note ?? null });
    return NextResponse.json({ ok: true, staff: row });
  } catch (e) {
    return guardError(e);
  }
}

export async function DELETE(request: NextRequest) {
  const session = await requireOwner(request);
  if (session instanceof NextResponse) return session;

  const parsed = targetSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'userId is required' }, { status: 400 });

  try {
    await revokeStaffRole({ userId: parsed.data.userId, actorId: session.userId });
    return NextResponse.json({ ok: true, staff: await listStaff() });
  } catch (e) {
    return guardError(e);
  }
}
