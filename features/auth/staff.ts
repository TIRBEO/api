import { prisma } from '@/infrastructure/db/prisma';
import { createAuditEvent } from '@/features/security/audit';
import {
  canGrantRole,
  isRoleKey,
  LEGACY_ROLE,
  permissionsForRole,
  ROLES,
  type RoleKey,
} from '@/features/auth/roles';

/* The staff roster: who is staff, what kind, and who decided that.
 *
 * Two writes happen together and neither is allowed to exist without the
 * other. A `staff_roles` row for an account with `is_admin = false` would be a
 * role nothing can use, because every non-admin path refuses before the role is
 * read; an `is_admin = true` with no row is the legacy account — staff that
 * reads as `admin` and shows as unassigned. So granting writes both, revoking
 * clears both, and this file is the only door that touches either.
 */

export type StaffRow = {
  userId: string;
  email: string | null;
  username: string | null;
  name: string | null;
  /** The role from `staff_roles`, or the legacy fallback when the account is
   *  staff with no row naming one. */
  role: RoleKey | null;
  /** False when `role` came from `is_admin` rather than from a decision
   *  somebody recorded. The screen shows that rather than presenting an
   *  invented assignment as somebody's choice. */
  assigned: boolean;
  grantedAt: Date | null;
  grantedBy: { userId: string; email: string; name: string | null } | null;
  note: string | null;
};

const ROSTER_SELECT = {
  id: true,
  email: true,
  username: true,
  isAdmin: true,
  profile: { select: { name: true } },
  staffRole: {
    select: {
      role: true,
      grantedAt: true,
      note: true,
      grantedByUser: { select: { id: true, email: true, profile: { select: { name: true } } } } } },
} as const;

type RosterUser = {
  id: string;
  email: string | null;
  username: string | null;
  isAdmin: boolean;
  profile: { name: string | null } | null;
  staffRole: {
    role: string;
    grantedAt: Date;
    note: string | null;
    grantedByUser: { id: string; email: string; profile: { name: string | null } | null } | null;
  } | null;
};

function toStaffRow(u: RosterUser): StaffRow {
  const known = u.staffRole && isRoleKey(u.staffRole.role) ? u.staffRole.role : null;
  return {
    userId: u.id,
    email: u.email ?? null,
    username: u.username ?? null,
    name: u.profile?.name ?? null,
    // An account is staff; a row says what kind. When the row names a role no
    // longer implemented, the account is still staff and still has to be shown
    // as such — the legacy fallback is the honest answer, `assigned: false`
    // says it was nobody's decision.
    role: known ?? (u.isAdmin ? LEGACY_ROLE : null),
    assigned: known !== null,
    grantedAt: known ? u.staffRole!.grantedAt : null,
    grantedBy: known && u.staffRole!.grantedByUser
      ? {
          userId: u.staffRole!.grantedByUser.id,
          email: u.staffRole!.grantedByUser.email,
          name: u.staffRole!.grantedByUser.profile?.name ?? null }
      : null,
    note: known ? u.staffRole!.note ?? null : null };
}

/** Every staff account, one row each, most powerful first. */
export async function listStaff(): Promise<StaffRow[]> {
  const rows = await prisma.user.findMany({ where: { isAdmin: true }, select: ROSTER_SELECT });
  return rows.map(toStaffRow).sort((a, b) => {
    // An owner scanning the roster should find themselves, then whoever was
    // made staff most recently.
    const rank = (r: RoleKey | null) => (r ? ROLES[r].rank : 0);
    const by = rank(b.role) - rank(a.role);
    if (by) return by;
    return (b.grantedAt?.getTime() ?? 0) - (a.grantedAt?.getTime() ?? 0);
  });
}

/** The roster rows for specific ids, for the response after a write. */
export async function listStaffByIds(userIds: string[]): Promise<StaffRow[]> {
  if (!userIds.length) return [];
  const rows = await prisma.user.findMany({ where: { id: { in: userIds } }, select: ROSTER_SELECT });
  return rows.map(toStaffRow);
}

/**
 * Staff holding a given power — the recipient list for a capability-scoped
 * mail, so an appeal alert reaches whoever can decide an appeal rather than
 * everyone who can open the console. Roles repeat on a roster, so the
 * resolution is cached per role for the call.
 */
export async function listStaffWithPermission(permission: string): Promise<StaffRecipient[]> {
  const staff = await listStaff();
  const granted = new Map<RoleKey, Set<string>>();
  const out: StaffRecipient[] = [];
  for (const row of staff) {
    if (!row.role || !row.email) continue;
    let set = granted.get(row.role);
    if (!set) {
      set = new Set(await permissionsForRole(row.role));
      granted.set(row.role, set);
    }
    if (set.has(permission)) {
      out.push({ userId: row.userId, email: row.email, username: row.username, name: row.name, role: row.role });
    }
  }
  return out;
}

export type StaffRecipient = {
  userId: string;
  email: string;
  username: string | null;
  name: string | null;
  role: RoleKey;
};

export class StaffGuardError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'StaffGuardError';
    this.status = status;
  }
}

/** Only an owner touches the roster — re-checked here rather than trusted to
 *  the route, because this service is also called from the account handlers. */
async function requireOwnerActor(actorId: string): Promise<void> {
  const row = await prisma.staffRole.findUnique({ where: { userId: actorId }, select: { role: true } });
  const actor = {
    userId: actorId,
    role: (row && isRoleKey(row.role) ? row.role : LEGACY_ROLE) as RoleKey,
    assigned: !!row };
  if (!canGrantRole(actor)) throw new StaffGuardError('Only an owner can change the staff roster', 403);
}

const countOwners = () => prisma.staffRole.count({ where: { role: 'owner' } });
const countStaff = () => prisma.user.count({ where: { isAdmin: true } });

/**
 * Make an account staff of a given kind, or change which kind it is.
 *
 * The two refusals are the reason this is a service and not an `upsert` at the
 * call site: a platform with no owner cannot appoint one, and removing the
 * last owner does that by accident. Both are decided against the counts as
 * they are immediately before the write, in the same transaction path, so two
 * owners revoking each other cannot both pass a check that was true for only
 * one of them.
 */
export async function grantStaffRole(opts: {
  userId: string;
  role: RoleKey;
  actorId: string;
  note?: string | null;
}): Promise<StaffRow> {
  const { userId, role, actorId, note } = opts;
  if (!isRoleKey(role)) throw new StaffGuardError(`Unknown staff role. Expected one of: ${Object.keys(ROLES).join(', ')}`, 400);
  await requireOwnerActor(actorId);

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isAdmin: true, staffRole: { select: { role: true } } } });
  if (!target) throw new StaffGuardError('No such account', 404);

  const wasOwner = target.staffRole?.role === 'owner';
  if (wasOwner && role !== 'owner' && (await countOwners()) <= 1) {
    throw new StaffGuardError('This is the last owner. Appoint another before changing this one.', 409);
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { isAdmin: true } });
    await tx.staffRole.upsert({
      where: { userId },
      create: { userId, role, grantedBy: actorId, note: note ?? null },
      update: { role, grantedBy: actorId, note: note ?? null, grantedAt: new Date() } });
  });

  await createAuditEvent({
    actorId,
    action: target.staffRole ? 'staff.role.changed' : 'staff.role.granted',
    targetType: 'user',
    targetId: userId,
    metadata: { role, previousRole: target.staffRole?.role ?? null, note: note ?? null } });

  const [row] = await listStaffByIds([userId]);
  return row;
}

/** Take an account off the roster: no role row, and not staff. */
export async function revokeStaffRole(opts: { userId: string; actorId: string }): Promise<void> {
  const { userId, actorId } = opts;
  await requireOwnerActor(actorId);

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, isAdmin: true, staffRole: { select: { role: true } } } });
  if (!target) throw new StaffGuardError('No such account', 404);
  if (!target.isAdmin && !target.staffRole) return;

  if (target.staffRole?.role === 'owner' && (await countOwners()) <= 1) {
    throw new StaffGuardError('This is the last owner. Appoint another before removing this one.', 409);
  }
  if ((await countStaff()) <= 1) {
    throw new StaffGuardError('The last staff account cannot be removed.', 409);
  }

  await prisma.$transaction([
    prisma.staffRole.deleteMany({ where: { userId } }),
    prisma.user.update({ where: { id: userId }, data: { isAdmin: false } })]);

  await createAuditEvent({
    actorId,
    action: 'staff.role.revoked',
    targetType: 'user',
    targetId: userId,
    metadata: { previousRole: target.staffRole?.role ?? LEGACY_ROLE, email: target.email } });
}
