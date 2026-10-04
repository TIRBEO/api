/**
 * Unit tests for the require2FA second-factor guard (features/auth/second-factor.ts).
 *
 * The DB is stubbed — the flag logic (only meaningful with an enrolled TOTP),
 * the missing/wrong/right TOTP paths, and atomic backup-code consumption are
 * exercised hermetically. No database, Redis, or network access.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.RECOVERY_PEPPER = 'test-recovery-pepper-for-second-factor-suite';

const mocks = vi.hoisted(() => ({
  userSecurity: null as any,
  updateManyResult: { count: 1 },
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    userSecurity: {
      findUnique: vi.fn(async () => mocks.userSecurity),
      updateMany: vi.fn(async () => mocks.updateManyResult),
    },
  },
}));

vi.mock('@/features/auth/totp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth/totp')>();
  return { ...actual, verifyTotp: vi.fn(async (code: string) => code === '123456') };
});

import { isRequire2FA, secondFactorBlocker } from '@/features/auth/second-factor';
import { prisma } from '@/infrastructure/db/prisma';
import { hashRecoveryCode } from '@/features/auth/password';

const SEC_BASE = {
  require2FA: true,
  totpEnabled: true,
  totpSecret: 'secret',
  backupCodes: [] as any[],
};

beforeEach(() => {
  mocks.userSecurity = { ...SEC_BASE };
  mocks.updateManyResult = { count: 1 };
  vi.clearAllMocks();
});

describe('isRequire2FA', () => {
  it('is false when no TOTP is enrolled, even with the flag set', async () => {
    mocks.userSecurity = { require2FA: true, totpEnabled: false };
    expect(await isRequire2FA('u1')).toBe(false);
  });

  it('is false when the flag is off', async () => {
    mocks.userSecurity = { require2FA: false, totpEnabled: true };
    expect(await isRequire2FA('u1')).toBe(false);
  });

  it('is true only when flag AND enrolled authenticator agree', async () => {
    expect(await isRequire2FA('u1')).toBe(true);
  });
});

describe('secondFactorBlocker', () => {
  it('passes (null) when require2FA is off — today\'s behavior, unchanged', async () => {
    mocks.userSecurity = { ...SEC_BASE, require2FA: false };
    expect(await secondFactorBlocker('u1', {})).toBeNull();
  });

  it('passes (null) when TOTP is not enrolled — the flag is inert', async () => {
    mocks.userSecurity = { require2FA: true, totpEnabled: false, totpSecret: null, backupCodes: [] };
    expect(await secondFactorBlocker('u1', {})).toBeNull();
  });

  it('rejects a missing code with SECOND_FACTOR_REQUIRED', async () => {
    const res = await secondFactorBlocker('u1', {});
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ error: 'SECOND_FACTOR_REQUIRED', requires2FA: true });
  });

  it('rejects a wrong code with INVALID_CODE', async () => {
    const res = await secondFactorBlocker('u1', { code: '000000' });
    expect(res?.status).toBe(400);
    expect(await res?.json()).toMatchObject({ error: 'INVALID_CODE' });
  });

  it('accepts a valid authenticator code', async () => {
    expect(await secondFactorBlocker('u1', { code: '123456' })).toBeNull();
  });

  it('accepts a valid backup code and marks it used atomically', async () => {
    const plain = 'AAAA-BBBB';
    mocks.userSecurity = {
      ...SEC_BASE,
      backupCodes: [{ code: hashRecoveryCode(plain), used: false, createdAt: 'x' }],
    };
    expect(await secondFactorBlocker('u1', { backupCode: plain })).toBeNull();
    expect(mocks.updateManyResult.count).toBe(1);
    const call = vi.mocked(prisma.userSecurity.updateMany).mock.calls[0][0] as any;
    expect(call.data.backupCodes[0].used).toBe(true);
  });

  it('treats a lost single-use race as already spent', async () => {
    const plain = 'AAAA-BBBB';
    mocks.userSecurity = {
      ...SEC_BASE,
      backupCodes: [{ code: hashRecoveryCode(plain), used: false, createdAt: 'x' }],
    };
    mocks.updateManyResult = { count: 0 };
    const res = await secondFactorBlocker('u1', { backupCode: plain });
    expect(res?.status).toBe(400);
  });
});
