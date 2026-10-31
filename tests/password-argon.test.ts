import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, hashRecoveryCode, hashOtpCode, verifyOtpCode, normalizeRecoveryCode } from '@/features/auth/password';

/* The Workers migration replaced the native argon2 addon with @noble/hashes.
   These fixtures were minted by the OLD stack (node-argon2 0.45, argon2id
   m=65536,t=3,p=1) and must keep verifying forever — they are what production
   rows contain. */

const LEGACY_HASHES: Array<[string, string]> = [
  ['S3cr3tPass12!', '$argon2id$v=19$m=65536,p=1,t=3$rEm0sASgVGyL28WUFIqRhg$xB52WE9NIm6rbGCPCpJGoivUlnqlFTzlIBRshsdTvtI'],
  ['Trlb!o#legacy-2', '$argon2id$v=19$m=65536,p=1,t=3$1aHcdOl5jsaxd/wFWEoBPA$kRccq+4P36fYJZojEl7lrkNBXajigwNm1wkghElLEdQ'],
];

describe('password hashing (pure-JS argon2id)', () => {
  it('verifies hashes produced by the legacy native argon2 addon', async () => {
    for (const [password, hash] of LEGACY_HASHES) {
      expect(await verifyPassword(hash, password)).toBe(true);
      expect(await verifyPassword(hash, `${password}-wrong`)).toBe(false);
    }
  }, 30_000);

  it('new hashes carry the exact PHC shape the old stack wrote', async () => {
    const hash = await hashPassword('hunter2 correct');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$.{22}\$.{43}$/);
    expect(await verifyPassword(hash, 'hunter2 correct')).toBe(true);
    expect(await verifyPassword(hash, 'hunter2 corect')).toBe(false);
  }, 30_000);

  it('salts are fresh per hash', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same')).toBe(true);
    expect(await verifyPassword(b, 'same')).toBe(true);
  }, 30_000);

  it('rejects malformed hashes instead of throwing', async () => {
    for (const bad of ['', 'garbage', '$argon2i$v=19$m=65536,p=1,t=3$AAA$AAA', '$argon2id$v=19$m=x$y$z', '$argon2id$v=19$m=65536,p=1,t=3$***$***']) {
      expect(await verifyPassword(bad, 'whatever')).toBe(false);
    }
  });
});

describe('peppered HMAC codes', () => {
  process.env.RECOVERY_PEPPER = 'test-recovery-pepper';
  process.env.OTP_PEPPER = 'test-otp-pepper';

  it('recovery codes normalize then hash to stable hex', () => {
    const a = hashRecoveryCode('  AB-12-CD ');
    expect(a).toBe(hashRecoveryCode(normalizeRecoveryCode('ab12cd')));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('otp hash + verify round-trip, forged code fails', async () => {
    const h = hashOtpCode('123456');
    expect(await verifyOtpCode(h, '123456')).toBe(true);
    expect(await verifyOtpCode(h, '654321')).toBe(false);
    expect(await verifyOtpCode(`${'0'.repeat(64)}`, '123456')).toBe(false);
  });
});
