import { prisma } from '@/infrastructure/db/prisma';

/* Who may do what in the console.
 *
 * Two tables are involved and they answer different questions.
 * `users.is_admin` says whether an account is staff at all — the flag the rest
 * of the product already reads, and the one that keeps working if this file
 * cannot be consulted. `staff_roles` says what kind of staff, and it is read
 * through `getStaffRole` below.
 *
 * The *powers* are not in the database. A permission set is behaviour: it has
 * to be reviewable by the person writing the endpoint that checks it, and a row
 * nobody reads at code-review time is how an account ends up with `people.delete`
 * because a query returned the wrong string. What *is* configurable per
 * installation is the delta — extra grants and revocations on top of a role,
 * kept in `app_config` under `staff.role.<role>` — so a team can widen a role
 * without a deploy, and the base role still says what it means in code.
 */

export type Permission = string;

/** Every permission the console and the API know how to enforce, with the
 *  screen it opens. The description is what a staff member is told they are
 *  being given, so it is written for them rather than for the schema. */
export const PERMISSION_CATALOGUE: Array<{ key: Permission; label: string; screen: string }> = [
  { key: 'console.read', label: 'Open the console at all', screen: '/admin' },
  { key: 'dashboard.read', label: 'The dashboard and its counts', screen: '/admin' },
  { key: 'analytics.read', label: 'Analytics', screen: '/admin/analytics' },
  { key: 'activity.read', label: 'The activity ledger and the audit trail', screen: '/admin/activity' },
  { key: 'people.read', label: 'Look up accounts', screen: '/admin/people' },
  { key: 'people.manage', label: 'Change an account: name, status, password, role flags', screen: '/admin/people/[id]' },
  { key: 'people.delete', label: 'Delete or hard-remove an account', screen: '/admin/people/[id]' },
  { key: 'appeals.read', label: 'Read appeals', screen: '/admin/appeals' },
  { key: 'appeals.manage', label: 'Uphold or overturn an appeal', screen: '/admin/appeals' },
  { key: 'blocklist.read', label: 'Read the blocklist', screen: '/admin/blocklist' },
  { key: 'blocklist.manage', label: 'Block and unblock addresses and accounts', screen: '/admin/blocklist' },
  { key: 'limits.read', label: 'Read rate and verification limits', screen: '/admin/limits' },
  { key: 'limits.manage', label: 'Change rate and verification limits', screen: '/admin/limits' },
  { key: 'security.read', label: 'Security events and posture', screen: '/admin/security-events' },
  { key: 'tickets.read', label: 'Read the support queue', screen: '/admin/tickets' },
  { key: 'tickets.answer', label: 'Answer a support request', screen: '/admin/tickets/[ref]' },
  { key: 'email.read', label: 'Deliveries and templates', screen: '/admin/email/deliveries' },
  { key: 'email.configure', label: 'Mail configuration and template editing', screen: '/admin/email/config' },
  { key: 'notifications.read', label: 'Read notifications', screen: '/admin/notifications' },
  { key: 'notifications.send', label: 'Broadcast a notification to accounts', screen: '/admin/notifications' },
  { key: 'maintenance.manage', label: 'Put the platform into maintenance', screen: '/admin/maintenance' },
  { key: 'staff.read', label: 'See who the staff are', screen: '/admin/staff' },
  { key: 'staff.manage', label: 'Grant and revoke staff roles', screen: '/admin/staff' },
];

export const ALL_PERMISSION_KEYS: Permission[] = PERMISSION_CATALOGUE.map((p) => p.key);

export type RoleKey = 'owner' | 'admin' | 'moderator' | 'support' | 'analyst';

export type RoleDefinition = {
  key: RoleKey;
  label: string;
  /** What the role is for, in the words a person assigning it would use. */
  purpose: string;
  /** Ordering only. Rank decides who may hand out which roles and who counts
   *  as "the last owner" — it deliberately does not imply that a higher rank
   *  grants more powers, because a moderator is not a weaker analyst or a
   *  stronger one; they are different jobs. */
  rank: number;
  permissions: Permission[];
};

const ALL = ALL_PERMISSION_KEYS;

export const ROLES: Record<RoleKey, RoleDefinition> = {
  owner: {
    key: 'owner',
    label: 'Owner',
    purpose: 'Runs the platform. The only role that can make or unmake other staff, and at least one has to exist.',
    rank: 5,
    permissions: ALL,
  },
  admin: {
    key: 'admin',
    label: 'Administrator',
    purpose: 'Everything the platform can do except decide who is staff.',
    rank: 4,
    permissions: ALL.filter((k) => k !== 'staff.manage'),
  },
  moderator: {
    key: 'moderator',
    label: 'Moderator',
    purpose: 'Enforces the rules: appeals, blocks, limits and the safety ledger.',
    rank: 3,
    permissions: [
      'console.read', 'dashboard.read', 'activity.read', 'people.read',
      'appeals.read', 'appeals.manage', 'blocklist.read', 'blocklist.manage',
      'limits.read', 'limits.manage', 'security.read',
      'tickets.read', 'tickets.answer', 'notifications.read',
    ],
  },
  support: {
    key: 'support',
    label: 'Support',
    purpose: 'Answers people. Reads an account to understand it, does not change it.',
    rank: 2,
    permissions: [
      'console.read', 'dashboard.read', 'activity.read', 'people.read',
      'tickets.read', 'tickets.answer', 'appeals.read',
      'email.read', 'notifications.read',
    ],
  },
  analyst: {
    key: 'analyst',
    label: 'Analyst',
    purpose: 'Reads everything and writes nothing. For whoever has to answer "what happened last week".',
    rank: 1,
    permissions: [
      'console.read', 'dashboard.read', 'analytics.read', 'activity.read',
      'people.read', 'security.read', 'appeals.read', 'blocklist.read', 'limits.read',
      'tickets.read', 'email.read', 'notifications.read',
    ],
  },
};

export const ROLE_KEYS = Object.keys(ROLES) as RoleKey[];

export function isRoleKey(value: unknown): value is RoleKey {
  return typeof value === 'string' && value in ROLES;
}

export function roleDefinition(role: string | null | undefined): RoleDefinition | null {
  return isRoleKey(role) ? ROLES[role] : null;
}

/** The legacy single-switch account: staff with no row in `staff_roles`.
 *  It gets `admin` rather than `owner` — it can keep running things, but
 *  handing out roles stays a deliberate act somebody has to record once. */
export const LEGACY_ROLE: RoleKey = 'admin';

/* ── Per-installation delta ─────────────────────────────────────────────── */

type RoleOverride = { grant?: Permission[]; revoke?: Permission[]; updatedBy?: string; updatedAt?: string };

const OVERRIDE_KEY = (role: RoleKey) => `staff.role.${role}`;

/** Read the extra grants and revocations stored for one role. A row that does
 *  not exist, does not parse, or names a permission that no longer exists is
 *  simply not applied — an unparseable override must never widen access. */
async function readOverride(role: RoleKey): Promise<RoleOverride | null> {
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: OVERRIDE_KEY(role) } });
    const value = row?.value as RoleOverride | null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch (e: any) {
    console.error('[ROLES] override read failed:', e?.message || e);
    return null;
  }
}

function applyOverride(base: Permission[], override: RoleOverride | null): Permission[] {
  if (!override) return base;
  const known = new Set(ALL_PERMISSION_KEYS);
  const granted = (override.grant ?? []).filter((p) => known.has(p));
  const revoked = new Set((override.revoke ?? []).filter((p) => known.has(p)));
  return [...new Set([...base, ...granted])].filter((p) => !revoked.has(p));
}

/** The registry plus whatever this installation added to it. */
export async function permissionsForRole(role: RoleKey): Promise<Permission[]> {
  return applyOverride(ROLES[role].permissions, await readOverride(role));
}

/** What the delta currently is, for the screen that edits it. */
export async function readRoleOverrides(): Promise<Record<string, RoleOverride>> {
  const out: Record<string, RoleOverride> = {};
  for (const role of ROLE_KEYS) {
    const value = await readOverride(role);
    if (value && (value.grant?.length || value.revoke?.length)) out[role] = value;
  }
  return out;
}

export async function saveRoleOverride(
  role: RoleKey,
  override: RoleOverride,
  updatedBy: string,
): Promise<void> {
  const known = new Set(ALL_PERMISSION_KEYS);
  const value = {
    grant: [...new Set((override.grant ?? []).filter((p) => known.has(p)))],
    revoke: [...new Set((override.revoke ?? []).filter((p) => known.has(p)))],
    updatedBy,
    updatedAt: new Date().toISOString(),
  };
  await prisma.appConfig.upsert({
    where: { key: OVERRIDE_KEY(role) },
    create: { key: OVERRIDE_KEY(role), value, description: `Permission delta for the ${role} role` },
    update: { value },
  });
}

/* ── The staff member ───────────────────────────────────────────────────── */

export type StaffIdentity = {
  userId: string;
  role: RoleKey;
  /** False for an account that is staff only because `is_admin` was never
   *  paired with a row here. The console says so rather than presenting a role
   *  nobody assigned. */
  assigned: boolean;
};

/** The role an account holds, or null when it is not staff. */
export async function getStaffRole(userId: string): Promise<StaffIdentity | null> {
  try {
    const [row, user] = await Promise.all([
      prisma.staffRole.findUnique({ where: { userId }, select: { role: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
    ]);
    if (!user) return null;
    if (row && isRoleKey(row.role)) return { userId, role: row.role, assigned: true };
    // A row naming a role that no longer exists in code is not a licence to
    // invent one: fall back to the legacy switch and let the roster screen
    // show it as unassigned.
    if (user.isAdmin) return { userId, role: LEGACY_ROLE, assigned: false };
    return null;
  } catch (e: any) {
    console.error('[ROLES] staff role lookup failed:', e?.message || e);
    // "Could not tell" is not "not staff": callers that treat a failure as a
    // refusal are safe, callers that treat it as a grant are not. Returning
    // null is the safe direction, and it is logged above.
    return null;
  }
}

export type PermissionSet = Record<Permission, boolean>;

function permissionSet(granted: Permission[]): PermissionSet {
  const set = new Set(granted);
  // The full catalogue, answered true or false. A caller that reads a missing
  // key as "not mentioned, so allowed" is a hole; a caller that reads it as
  // false is merely correct by accident, which is the same outcome.
  return Object.fromEntries(ALL_PERMISSION_KEYS.map((key) => [key, set.has(key)])) as PermissionSet;
}

export type StaffContext = {
  staff: StaffIdentity;
  /** Every known permission, resolved for this role including this
   *  installation's delta. */
  permissions: PermissionSet;
};

/** The one lookup a guarded request needs: is this account staff, and if so
 *  what may it do. Null means "not staff" — never "unknown", because the
 *  underlying query already logs and fails closed. */
export async function resolveStaff(userId: string): Promise<StaffContext | null> {
  const staff = await getStaffRole(userId);
  if (!staff) return null;
  return { staff, permissions: permissionSet(await permissionsForRole(staff.role)) };
}

/** The resolved answer for one account. Non-staff gets every key false rather
 *  than an empty object, so a screen can render "no powers" instead of
 *  crashing on a shape it did not expect. */
export async function getEffectivePermissions(userId: string): Promise<PermissionSet> {
  const ctx = await resolveStaff(userId);
  return ctx?.permissions ?? permissionSet([]);
}

export function allows(permissions: PermissionSet, permission: Permission): boolean {
  return permissions[permission] === true;
}

export function permissionLabel(permission: Permission): string {
  return PERMISSION_CATALOGUE.find((p) => p.key === permission)?.label ?? permission;
}

/* ── Who may hand out what ──────────────────────────────────────────────── */

/**
 * Only an owner may touch the roster at all. This is deliberately a question
 * about the *actor* alone: the guard that keeps the platform from being left
 * without an owner lives in `staff.ts` with the writes, where it can see the
 * row it is about to change, and it has to hold even if every override and
 * rank in the registry above gets edited badly.
 */
export function canGrantRole(actor: StaffIdentity): boolean {
  return actor.role === 'owner';
}

export function roleRank(role: RoleKey): number {
  return ROLES[role].rank;
}

/** Human-readable list for an error message. */
export function roleList(): string {
  return ROLE_KEYS.map((k) => ROLES[k].label).join(', ');
}
