import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Two-factor secrets at rest.
 *
 * A TOTP secret is the whole of the second factor: whoever holds the string can
 * generate every code, forever. Stored in the clear, one read of the wrong column
 * — a dump, a backup, a bug that logs a row — turns "password plus phone" into a
 * password. So the secret is sealed with an application key the database does not
 * have, and unsealed only where a code is actually being checked.
 *
 * `TOTP_SECRET_KEY` is that key. Without it the module passes values through
 * unchanged, which is what the fleet did before it existed: development keeps
 * working with no setup, and production must set it to get the guarantee.
 *
 * CHANGING OR REMOVING THE KEY invalidates every sealed secret — owners would
 * read "invalid code" until they re-enrol. Keep a copy of the old value if it
 * ever has to rotate.
 */

const PREFIX = 'v1:';
let warnedNoKey = false;

function sealingKey(): Buffer | null {
  const raw = (process.env.TOTP_SECRET_KEY || '').trim();
  if (!raw) return null;
  // Any shape of secret (32-byte hex, a passphrase, a base64 blob) normalises to
  // the one 256-bit key AES-GCM needs.
  return createHash('sha256').update(raw).digest();
}

/** Seal a secret, or hand it back unchanged when no key is configured. */
export function encryptSecret(plain: string): string {
  const key = sealingKey();
  if (!key) {
    if (!warnedNoKey && process.env.NODE_ENV === 'production') {
      warnedNoKey = true;
      console.error('[SECRET-BOX] TOTP_SECRET_KEY is not set — 2FA secrets are being stored in plaintext.');
    }
    return plain;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

/**
 * Open a stored secret. Values written before sealing existed (and values written
 * while no key was configured) are bare base32 and pass straight through, so
 * turning the key on does not lock anybody out of an account already enrolled.
 */
export function decryptSecret(stored: string): string {
  if (!stored || !stored.startsWith(PREFIX)) return stored;
  const key = sealingKey();
  if (!key) {
    console.error('[SECRET-BOX] A sealed secret was read without TOTP_SECRET_KEY set — it cannot be opened.');
    // Throwing keeps the caller from treating a ciphertext as a secret and
    // "verifying" a code against it: the answer must be a refusal, not a maybe.
    throw new Error('sealed secret unreadable: TOTP_SECRET_KEY missing');
  }
  const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('sealed secret is malformed');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}
