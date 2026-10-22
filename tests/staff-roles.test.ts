/**
 * The staff roles registry and the roster guards (features/auth/roles.ts,
 * features/auth/staff.ts).
 *
 * What deserves a test here is not the shape of a row but the three things a
 * typo can get wrong in security code: an override that widens access when it
 * should only narrow it, a role silently losing a power because a permission
 * was renamed on one side, and the platform being left without an owner.
 *
 * Prisma is two in-memory maps — `users.is_admin` and `staff_roles` — because
 * the whole point of the split is that the two are always written together, and
 * a test that only had one of them could not tell.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// One hoisted block for both the tables and the stub: `vi.mock` is hoisted
// above the declarations, so a factory that reaches for a top-level `db` would
// read it before it exists.
const { state, db } = vi.hoisted(() => {
const state = {
  users: new Map<string, any>(),
  roles: new Map<string, { role: string; grantedBy: string | null; note: string | null; grantedAt: Date }>(),
  config: new Map<string, any>(),
  audit: [] as any[],
};

function rosterRow(u: any) {
  const row = state.roles.get(u.id);
  return {
    ...u,
    staffRole: row
      ? {
          role: row.role,
          grantedAt: row.grantedAt,
          note: row.note,
          grantedByUser: row.grantedBy
            ? { id: row.grantedBy, email: state.users.get(row.grantedBy)?.email ?? null, profile: { name: null } }
            : null }
      : null };
}

const db: any = {
  user: {
    findUnique: vi.fn(async ({ where }: any) => {
      const u = state.users.get(where.id ?? where.email);
      return u ? rosterRow(u) : null;
    }),
    findMany: vi.fn(async ({ where }: any) => [...state.users.values()]
      .filter((u) => !where?.isAdmin || u.isAdmin === true)
      .filter((u) => !where?.id?.in || where.id.in.includes(u.id))
      .map(rosterRow)),
    count: vi.fn(async ({ where }: any) => [...state.users.values()]
      .filter((u) => !where?.isAdmin || u.isAdmin === true).length),
    update: vi.fn(async ({ where, data }: any) => {
      const u = state.users.get(where.id);
      Object.assign(u, data);
      return u;
    }),
  },
  staffRole: {
    findUnique: vi.fn(async ({ where }: any) => state.roles.get(where.userId) ?? null),
    count: vi.fn(async ({ where }: any) => [...state.roles.values()]
      .filter((r) => !where?.role || r.role === where.role).length),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = state.roles.get(where.userId);
      const next = existing ? { ...existing, ...update } : create;
      state.roles.set(where.userId, next);
      return next;
    }),
    create: vi.fn(async ({ data }: any) => {
      state.roles.set(data.userId, data);
      return data;
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      state.roles.delete(where.userId);
      return { count: 1 };
    }),
  },
  appConfig: {
    findUnique: vi.fn(async ({ where }: any) => state.config.has(where.key) ? { key: where.key, value: state.config.get(where.key) } : null),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      state.config.set(where.key, state.config.has(where.key) ? { ...state.config.get(where.key), ...update.value } : create.value);
      return { key: where.key, value: state.config.get(where.key) };
    }),
  },
  $transaction: vi.fn(async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(db))),
};

  return { state, db };
});

vi.mock('@/infrastructure/db/prisma', () => ({ prisma: db }));
vi.mock('@/features/security/audit', () => ({
  createAuditEvent: vi.fn(async (input: any) => { state.audit.push(input); }),
}));

import {
  ALL_PERMISSION_KEYS,
  getEffectivePermissions,
  isRoleKey,
  LEGACY_ROLE,
  permissionsForRole,
  resolveStaff,
  ROLES,
  ROLE_KEYS,
  saveRoleOverride,
} from '@/features/auth/roles';
import { grantStaffRole, listStaff, listStaffWithPermission, revokeStaffRole, StaffGuardError } from '@/features/auth/staff';

function seedUser(id: string, over: Partial<any> = {}) {
  const u = { id, email: `${id}@tirbeo.com`, username: id, isAdmin: false, profile: { name: id } , ...over };
  state.users.set(id, u);
  return u;
}

beforeEach(() => {
  state.users.clear();
  state.roles.clear();
  state.config.clear();
  state.audit.length = 0;
  vi.clearAllMocks();
});

describe('the permission catalogue', () => {
  it('names every permission the roles mention, and no permission twice', () => {
    const known = new Set(ALL_PERMISSION_KEYS);
    const duplicates = ALL_PERMISSION_KEYS.filter((k, i) => ALL_PERMISSION_KEYS.indexOf(k) !== i);
    expect(duplicates).toEqual([]);
    for (const key of ROLE_KEYS) {
      const unknown = ROLES[key].permissions.filter((p) => !known.has(p));
      // A role listing a permission nothing checks is a power that does nothing,
      // which is worse than absent: it reads as granted.
      expect(unknown).toEqual([]);
    }
  });

  it('gives every role a screen it can open, and the owner everything', () => {
    for (const key of ROLE_KEYS) {
      expect(ROLES[key].permissions).toContain('console.read');
    }
    expect(ROLES.owner.permissions).toEqual([...ALL_PERMISSION_KEYS]);
    expect(ROLES.admin.permissions).not.toContain('staff.manage');
    expect(ROLES.analyst.permissions.every((p) => p.endsWith('.read'))).toBe(true);
  });
});

describe('the per-installation delta', () => {
  it('applies a grant and a revocation on top of the role', async () => {
    await saveRoleOverride('moderator', { grant: ['analytics.read'], revoke: ['appeals.manage'] }, 'owner-1');
    const granted = await permissionsForRole('moderator');
    expect(granted).toContain('analytics.read');
    expect(granted).not.toContain('appeals.manage');
  });

  it('refuses a permission name nothing recognises, so a stale row cannot invent one', async () => {
    await saveRoleOverride('support', { grant: ['people.destroy', 'email.configure'] }, 'owner-1');
    const granted = await permissionsForRole('support');
    expect(granted).not.toContain('people.destroy');
    // `email.configure` is real, so it survives — the filter is about names,
    // not about which role is "supposed" to have it.
    expect(granted).toContain('email.configure');
  });

  it('treats a stored value that is not an object as no delta at all', async () => {
    state.config.set('staff.role.support', ['people.delete']);
    expect(await permissionsForRole('support')).toEqual(ROLES.support.permissions);
  });

  it('leaves every other role untouched when one has a delta', async () => {
    await saveRoleOverride('support', { revoke: ['tickets.answer'] }, 'owner-1');
    expect(await permissionsForRole('analyst')).toEqual(ROLES.analyst.permissions);
  });
});

describe('who is staff', () => {
  it('reads a role row as an assigned role', async () => {
    seedUser('mod-1');
    state.roles.set('mod-1', { role: 'moderator', grantedBy: 'owner-1', note: null, grantedAt: new Date() });
    expect(await resolveStaff('mod-1')).toMatchObject({
      staff: { role: 'moderator', assigned: true } });
  });

  it('reads a legacy is_admin account as the fallback role, unassigned', async () => {
    seedUser('old-1', { isAdmin: true });
    const ctx = await resolveStaff('old-1');
    expect(ctx?.staff).toEqual({ userId: 'old-1', role: LEGACY_ROLE, assigned: false });
  });

  it('is not staff at all when neither half says so', async () => {
    seedUser('plain-1');
    expect(await resolveStaff('plain-1')).toBeNull();
  });

  it('ignores a row naming a role the code no longer implements', async () => {
    seedUser('ghost-1', { isAdmin: true });
    state.roles.set('ghost-1', { role: 'super_admin', grantedBy: null, note: null, grantedAt: new Date() });
    const ctx = await resolveStaff('ghost-1');
    expect(ctx?.staff.role).toBe(LEGACY_ROLE);
    expect(ctx?.staff.assigned).toBe(false);
  });

  it('answers "not staff" when the lookup fails, never "all powers"', async () => {
    db.user.findUnique.mockRejectedValueOnce(new Error('down'));
    await expect(resolveStaff('anyone')).resolves.toBeNull();
    const set = await getEffectivePermissions('anyone');
    expect(Object.values(set)).not.toContain(true);
  });

  it('answers the full catalogue, so an absent key cannot read as allowed', async () => {
    seedUser('sup-1');
    state.roles.set('sup-1', { role: 'support', grantedBy: 'owner-1', note: null, grantedAt: new Date() });
    const set = await getEffectivePermissions('sup-1');
    expect(Object.keys(set).length).toBe(ALL_PERMISSION_KEYS.length);
    expect(set['tickets.answer']).toBe(true);
    expect(set['people.delete']).toBe(false);
  });
});

describe('the recipient list for a staff mail', () => {
  beforeEach(() => {
    for (const key of ROLE_KEYS) {
      seedUser(`${key}-1`, { isAdmin: true });
      state.roles.set(`${key}-1`, { role: key, grantedBy: 'owner-1', note: null, grantedAt: new Date() });
    }
  });

  it('reaches whoever can answer a request and nobody who cannot', async () => {
    const emails = (await listStaffWithPermission('tickets.answer')).map((s) => s.userId).sort();
    expect(emails).toEqual(['admin-1', 'moderator-1', 'owner-1', 'support-1']);
  });

  it('reaches the read-only analyst for a read permission', async () => {
    const emails = (await listStaffWithPermission('analytics.read')).map((s) => s.userId).sort();
    expect(emails).toEqual(['admin-1', 'analyst-1', 'owner-1']);
  });

  it('respects the delta, so a mail follows the powers and not the role name', async () => {
    await saveRoleOverride('analyst', { grant: ['tickets.answer'] }, 'owner-1');
    const emails = (await listStaffWithPermission('tickets.answer')).map((s) => s.userId);
    expect(emails).toContain('analyst-1');
  });
});

describe('the roster screen', () => {
  it('lists staff with the role somebody assigned, marked as such', async () => {
    seedUser('owner-1', { isAdmin: true });
    seedUser('legacy-1', { isAdmin: true });
    state.roles.set('owner-1', { role: 'owner', grantedBy: null, note: 'first', grantedAt: new Date('2026-01-01') });
    const rows = await listStaff();
    expect(rows.map((r) => r.userId).sort()).toEqual(['legacy-1', 'owner-1']);
    expect(rows.find((r) => r.userId === 'owner-1')).toMatchObject({ role: 'owner', assigned: true, note: 'first' });
    expect(rows.find((r) => r.userId === 'legacy-1')).toMatchObject({ role: LEGACY_ROLE, assigned: false });
  });

  it('puts the owner first when the list is sorted by what the roles can do', async () => {
    for (const key of ['analyst', 'owner', 'support'] as const) {
      seedUser(`${key}-1`, { isAdmin: true });
      state.roles.set(`${key}-1`, { role: key, grantedBy: null, note: null, grantedAt: new Date('2026-01-01') });
    }
    expect((await listStaff()).map((r) => r.role)).toEqual(['owner', 'support', 'analyst']);
  });
});

describe('granting a role', () => {
  beforeEach(() => {
    seedUser('owner-1', { isAdmin: true });
    seedUser('owner-2', { isAdmin: true });
    seedUser('target');
    state.roles.set('owner-1', { role: 'owner', grantedBy: null, note: null, grantedAt: new Date() });
    state.roles.set('owner-2', { role: 'owner', grantedBy: 'owner-1', note: null, grantedAt: new Date() });
  });

  it('writes both halves — the switch and the row — and audits who did it', async () => {
    const row = await grantStaffRole({ userId: 'target', role: 'moderator', actorId: 'owner-1', note: 'on-call' });
    expect(state.users.get('target').isAdmin).toBe(true);
    expect(state.roles.get('target')).toMatchObject({ role: 'moderator', grantedBy: 'owner-1', note: 'on-call' });
    expect(row).toMatchObject({ userId: 'target', role: 'moderator', assigned: true });
    expect(state.audit[0]).toMatchObject({ actorId: 'owner-1', action: 'staff.role.granted', targetId: 'target' });
  });

  it('refuses an actor who is not an owner, even with staff.manage', async () => {
    seedUser('admin-1', { isAdmin: true });
    state.roles.set('admin-1', { role: 'admin', grantedBy: 'owner-1', note: null, grantedAt: new Date() });
    await expect(grantStaffRole({ userId: 'target', role: 'moderator', actorId: 'admin-1' }))
      .rejects.toMatchObject({ status: 403 } as Partial<StaffGuardError>);
    expect(state.roles.has('target')).toBe(false);
  });

  it('refuses to downgrade the last owner', async () => {
    state.roles.delete('owner-2');
    await expect(grantStaffRole({ userId: 'owner-1', role: 'admin', actorId: 'owner-1' }))
      .rejects.toBeInstanceOf(StaffGuardError);
    expect(state.roles.get('owner-1')?.role).toBe('owner');
  });

  it('allows it once another owner exists, which is the point of the guard', async () => {
    await expect(grantStaffRole({ userId: 'owner-1', role: 'admin', actorId: 'owner-2' })).resolves.toBeTruthy();
    expect(state.roles.get('owner-1')?.role).toBe('admin');
  });

  it('refuses an account that does not exist', async () => {
    await expect(grantStaffRole({ userId: 'nobody', role: 'support', actorId: 'owner-1' }))
      .rejects.toMatchObject({ status: 404 } as Partial<StaffGuardError>);
  });

  it('refuses a role name nothing implements', async () => {
    await expect(grantStaffRole({ userId: 'target', role: 'super_admin' as any, actorId: 'owner-1' }))
      .rejects.toMatchObject({ status: 400 } as Partial<StaffGuardError>);
    expect(isRoleKey('super_admin')).toBe(false);
  });
});

describe('revoking a role', () => {
  beforeEach(() => {
    seedUser('owner-1', { isAdmin: true });
    seedUser('mod-1', { isAdmin: true });
    state.roles.set('owner-1', { role: 'owner', grantedBy: null, note: null, grantedAt: new Date() });
    state.roles.set('mod-1', { role: 'moderator', grantedBy: 'owner-1', note: null, grantedAt: new Date() });
  });

  it('clears both halves and records it', async () => {
    await revokeStaffRole({ userId: 'mod-1', actorId: 'owner-1' });
    expect(state.roles.has('mod-1')).toBe(false);
    expect(state.users.get('mod-1').isAdmin).toBe(false);
    expect(state.audit[0]).toMatchObject({ action: 'staff.role.revoked', targetId: 'mod-1' });
  });

  it('refuses to remove the last owner', async () => {
    await expect(revokeStaffRole({ userId: 'owner-1', actorId: 'owner-1' }))
      .rejects.toMatchObject({ status: 409 } as Partial<StaffGuardError>);
    expect(state.roles.has('owner-1')).toBe(true);
  });

  it('refuses to remove the last staff account of any kind', async () => {
    state.roles.delete('mod-1');
    await expect(revokeStaffRole({ userId: 'mod-1', actorId: 'owner-1' })).resolves.toBeUndefined();
    // owner-1 is still staff, so the platform keeps an owner; now try the last one.
    await expect(revokeStaffRole({ userId: 'owner-1', actorId: 'owner-1' }))
      .rejects.toBeInstanceOf(StaffGuardError);
  });

  it('is a no-op for an account that was never staff', async () => {
    seedUser('plain-1');
    await revokeStaffRole({ userId: 'plain-1', actorId: 'owner-1' });
    expect(state.audit).toHaveLength(0);
  });

  it('refuses an actor who is not an owner', async () => {
    seedUser('mod-2', { isAdmin: true });
    state.roles.set('mod-2', { role: 'moderator', grantedBy: 'owner-1', note: null, grantedAt: new Date() });
    await expect(revokeStaffRole({ userId: 'mod-1', actorId: 'mod-2' }))
      .rejects.toMatchObject({ status: 403 } as Partial<StaffGuardError>);
    expect(state.roles.has('mod-1')).toBe(true);
  });
});
