import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/features/auth/http-guards';
import {
  ALL_PERMISSION_KEYS,
  isRoleKey,
  PERMISSION_CATALOGUE,
  permissionsForRole,
  readRoleOverrides,
  ROLES,
  ROLE_KEYS,
  saveRoleOverride,
  type RoleKey,
} from '@/features/auth/roles';

/* /api/admin/staff/roles — the per-installation delta on each role.
 *
 * A role's base powers live in `features/auth/roles.ts` and are code, so they
 * can be read at review time; what lives here is only what this installation
 * added and removed on top. That split is the whole design: a team can give
 * Moderators the ability to answer mail without anybody editing a JSON blob
 * into an account that has no idea what `email.configure` opens.
 *
 *   GET → every role, with its base powers, this installation's delta, and the
 *         resolved answer — three columns, because "what the role means" and
 *         "what it currently does" are different facts and a screen that shows
 *         only one of them hides the edit that made them differ.
 *   PUT → { role, grant?, revoke? }
 *
 * Writing the delta for `owner` needs an owner: an override that could be
 * edited by whoever the previous override let in is how a role quietly becomes
 * a path to the roster. */

const deltaSchema = z.object({
  role: z.string(),
  grant: z.array(z.string()).max(ALL_PERMISSION_KEYS.length).optional(),
  revoke: z.array(z.string()).max(ALL_PERMISSION_KEYS.length).optional(),
});

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, 'staff.read');
  if (session instanceof NextResponse) return session;

  const overrides = await readRoleOverrides();
  const roles = await Promise.all(ROLE_KEYS.map(async (key) => ({
    key,
    label: ROLES[key].label,
    purpose: ROLES[key].purpose,
    rank: ROLES[key].rank,
    base: ROLES[key].permissions,
    delta: overrides[key] ?? { grant: [], revoke: [] },
    effective: await permissionsForRole(key),
  })));

  return NextResponse.json({
    roles,
    permissions: PERMISSION_CATALOGUE,
    canEdit: session.permissions['staff.manage'] === true,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function PUT(request: NextRequest) {
  const session = await requirePermission(request, 'staff.manage');
  if (session instanceof NextResponse) return session;

  const parsed = deltaSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'role is required, with optional grant[] and revoke[] of permission keys' }, { status: 400 });
  }
  const { role, grant = [], revoke = [] } = parsed.data;
  if (!isRoleKey(role)) {
    return NextResponse.json({ error: `Unknown role: ${role}` }, { status: 400 });
  }

  const known = new Set(ALL_PERMISSION_KEYS);
  const unknown = [...grant, ...revoke].filter((p) => !known.has(p));
  if (unknown.length) {
    // Refused rather than dropped: silently ignoring a permission nobody
    // recognises is how a delta written against an old name ends up doing
    // nothing at all while looking like it did something.
    return NextResponse.json({ error: `Unknown permission: ${unknown.join(', ')}` }, { status: 400 });
  }
  if (role === 'owner' && session.staff.role !== 'owner') {
    return NextResponse.json({ error: 'Only an owner can change what an owner can do.' }, { status: 403 });
  }

  await saveRoleOverride(role as RoleKey, { grant, revoke }, session.userId);
  return NextResponse.json({ ok: true, role, effective: await permissionsForRole(role as RoleKey) });
}
