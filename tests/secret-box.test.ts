import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '@/features/auth/secret-box';

/* The Workers migration moved secret-box to WebCrypto AES-GCM (node:crypto on
   the self-hosted box). This fixture was sealed by the OLD synchronous
   node-crypto implementation and must still open. */

const LEGACY_SEALED = 'v1:SQIvnXw935iGqNBx.1XETqqs8EHVgR2qfHMPK0A.hIAbdjC6Z8ENumrwrnS9bA';

describe('secret-box (WebCrypto AES-256-GCM)', () => {
  it('opens a secret sealed by the legacy implementation', async () => {
    process.env.TOTP_SECRET_KEY = 'legacy-key-123';
    expect(await decryptSecret(LEGACY_SEALED)).toBe('JBSZG43ANFXuxTf0');
  });

  it('round-trips new seals and passes plaintext through unsealed rows', async () => {
    process.env.TOTP_SECRET_KEY = 'round-trip-key';
    const sealed = await encryptSecret('ABCDEF234567');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(await decryptSecret(sealed)).toBe('ABCDEF234567');
    // pre-sealing rows are bare base32 and must survive untouched
    expect(await decryptSecret('NBBZAYQUM5QXIRPG')).toBe('NBBZAYQUM5QXIRPG');
  });

  it('tampered ciphertext fails authentication instead of returning garbage', async () => {
    process.env.TOTP_SECRET_KEY = 'round-trip-key';
    const sealed = await encryptSecret('secret-value');
    const [iv, tag, data] = sealed.slice(3).split('.');
    const flipped = Buffer.from(data!, 'base64url');
    flipped[0] ^= 0xff;
    const tampered = `v1:${iv}.${tag}.${flipped.toString('base64url')}`;
    await expect(decryptSecret(tampered)).rejects.toThrow(/failed authentication/);
  });

  it('no key configured means pass-through (dev mode)', async () => {
    delete process.env.TOTP_SECRET_KEY;
    expect(await encryptSecret('plain')).toBe('plain');
    expect(await decryptSecret('plain')).toBe('plain');
  });
});
