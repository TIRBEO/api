/**
 * Unit tests for the account status level (features/status/accountStatus).
 *
 * Prisma is stubbed with an in-memory `user_preferences` table so these stay
 * pure unit tests — no database, no network. The auth guards are stubbed too:
 * the handlers' job here is routing the number, not validating sessions.
 *
 * The behaviour these tests pin down is the whole point of the feature:
 * every account answers with a number, 0 means "nothing decided", nothing
 * about a missing row ever surfaces as null/404, and only the admin edge
 * can move the value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/infrastructure/db/prisma', () => {
  const rows = new Map<string, any>();
  const userPreferences = {
    findUnique: vi.fn(async ({ where }: any) => rows.get(where.userId) ?? null),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const id = where.userId;
      const next = rows.has(id) ? { ...rows.get(id), ...update } : { ...create };
      rows.set(id, next);
      return next;
    }),
  };
  const user = {
    findUnique: vi.fn(async ({ where }: any) => (rows.has(`user:${where.id}`) ? { id: where.id } : null)),
  };
  return { prisma: { userPreferences, user }, __rows: rows };
});

vi.mock('@/features/auth/http-guards', () => ({
  getSession: vi.fn(async () => ({ userId: 'u1', email: 'e@u.dev' })),
  requireAdmin: vi.fn(async () => ({ userId: 'admin1', email: 'a@u.dev', adminRole: 'admin' })),
}));

import { prisma } from '@/infrastructure/db/prisma';
import {
  accountStatusHandler,
  adminAccountStatusHandler,
  loadAccountStatus,
  setAccountStatusLevel,
  isValidStatusLevel,
  DEFAULT_STATUS_LEVEL,
} from '@/features/status/accountStatus';

const mockFindUnique = prisma.userPreferences.findUnique as ReturnType<typeof vi.fn>;
const mockUserFindUnique = prisma.user.findUnique as ReturnType<typeof vi.fn>;

/** Replace the prisma stub with a fresh in-memory table. Rows seeded here use
    the same shape the real `user_preferences` table holds. */
function freshTable(seedData: Record<string, any> = {}) {
  const rows = new Map<string, any>(
    Object.entries(seedData).filter(([k]) => !k.startsWith('user:')),
  );
  mockFindUnique.mockImplementation(async ({ where }: any) => rows.get(where.userId) ?? null);
  (prisma.userPreferences.upsert as ReturnType<typeof vi.fn>).mockImplementation(
    async ({ where, create, update }: any) => {
      const next = rows.has(where.userId) ? { ...rows.get(where.userId), ...update } : { ...create };
      rows.set(where.userId, next);
      return next;
    },
  );
  mockUserFindUnique.mockImplementation(async ({ where }: any) =>
    where.id === 'u1' ? { id: where.id } : null,
  );
  return rows;
}

function put(path: string, method = 'GET', body?: unknown) {
  return new NextRequest(`https://api.tirbeo.com${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
}

describe('isValidStatusLevel', () => {
  it('accepts whole numbers zero and above', () => {
    expect(isValidStatusLevel(0)).toBe(true);
    expect(isValidStatusLevel(3)).toBe(true);
  });
  it('rejects negatives, fractions, strings, null', () => {
    expect(isValidStatusLevel(-1)).toBe(false);
    expect(isValidStatusLevel(1.5)).toBe(false);
    expect(isValidStatusLevel('2')).toBe(false);
    expect(isValidStatusLevel(null)).toBe(false);
    expect(isValidStatusLevel(undefined)).toBe(false);
  });
});

describe('loadAccountStatus', () => {
  beforeEach(() => {
    freshTable();
  });

  it('answers 0 for an account with no preferences row at all', async () => {
    const status = await loadAccountStatus('brand-new');
    expect(status.level).toBe(DEFAULT_STATUS_LEVEL);
    expect(status.level).toBe(0);
  });

  it('materialises the 0 into the store so the account carries it from then on', async () => {
    const rows = freshTable();
    await loadAccountStatus('brand-new');
    expect(rows.get('brand-new')?.misc?.accountStatus?.level).toBe(0);
  });

  it('returns the level an admin raised', async () => {
    freshTable({ u9: { misc: { accountStatus: { level: 2, updatedBy: 'admin:x', updatedAt: '2026-10-01T00:00:00.000Z' } } } });
    const status = await loadAccountStatus('u9');
    expect(status.level).toBe(2);
    expect(status.updatedBy).toBe('admin:x');
    expect(status.updatedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('reads junk in the blob as 0 rather than erroring or echoing nonsense', async () => {
    for (const junk of ['2', -1, 1.5, null, {}]) {
      freshTable({ uJunk: { misc: { accountStatus: { level: junk } } } });
      expect((await loadAccountStatus('uJunk')).level).toBe(0);
    }
  });

  it('never disturbs the settings bag that shares misc', async () => {
    const rows = freshTable({ uS: { misc: { settings: { 'tirbeo:language': 'ne' } } } });
    await loadAccountStatus('uS');
    expect(rows.get('uS').misc.settings['tirbeo:language']).toBe('ne');
    expect(rows.get('uS').misc.accountStatus.level).toBe(0);
  });
});

describe('setAccountStatusLevel', () => {
  beforeEach(() => {
    freshTable();
  });

  it('writes the level and reads it back with the actor recorded', async () => {
    const status = await setAccountStatusLevel('u1', 4, 'admin:me');
    expect(status.level).toBe(4);
    expect(status.updatedBy).toBe('admin:me');
  });

  it('can return an account to 0', async () => {
    await setAccountStatusLevel('u1', 3, 'admin:me');
    const status = await setAccountStatusLevel('u1', 0, 'admin:me');
    expect(status.level).toBe(0);
  });
});

describe('accountStatusHandler (GET /api/user/account-status)', () => {
  beforeEach(() => {
    freshTable();
  });

  it('answers 200 with level 0 for an account nobody has decided about', async () => {
    const res = await accountStatusHandler(put('/api/user/account-status'));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.level).toBe(0);
    expect(body.ok).toBe(true);
  });
});

describe('adminAccountStatusHandler (PUT /api/admin/account-status)', () => {
  beforeEach(() => {
    freshTable();
  });

  it('raises an account and echoes the stored value', async () => {
    const res = await adminAccountStatusHandler(put('/api/admin/account-status', 'PUT', { userId: 'u1', level: 2 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).level).toBe(2);
  });

  it('refuses a level that is not a whole number 0 or above', async () => {
    for (const level of [-1, 1.5, '2', null, undefined]) {
      const res = await adminAccountStatusHandler(put('/api/admin/account-status', 'PUT', { userId: 'u1', level }));
      expect(res.status).toBe(400);
    }
  });

  it('refuses an unknown account', async () => {
    const res = await adminAccountStatusHandler(put('/api/admin/account-status', 'PUT', { userId: 'ghost', level: 1 }));
    expect(res.status).toBe(404);
  });

  it('refuses a missing userId', async () => {
    const res = await adminAccountStatusHandler(put('/api/admin/account-status', 'PUT', { level: 1 }));
    expect(res.status).toBe(400);
  });
});
