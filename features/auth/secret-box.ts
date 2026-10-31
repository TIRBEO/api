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
 *
 * AES-256-GCM runs on WebCrypto wherever `crypto.subtle` exists (Workers) and on
 * node:crypto otherwise. The envelope — v1:iv.tag.ciphertext, base64url — is
 * identical on both paths, so a secret sealed on one runtime opens on the other.
 */

const PREFIX = 'v1:';
let warnedNoKey = false;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Sealing key as plain bytes — WebCrypto refuses Buffer views. */
async function sealingKeyBytes(): Promise<ArrayBuffer | null> {
  const raw = (process.env.TOTP_SECRET_KEY || '').trim();
  if (!raw) return null;
  // Any shape of secret (32-byte hex, a passphrase, a base64 blob) normalises to
  // the one 256-bit key AES-GCM needs.
  if (typeof crypto?.subtle !== 'undefined') {
    return await crypto.subtle.digest('SHA-256', enc.encode(raw));
  }
  return new Uint8Array(createHash('sha256').update(raw).digest()).buffer;
}

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Seal a secret, or hand it back unchanged when no key is configured. */
export async function encryptSecret(plain: string): Promise<string> {
  const key = await sealingKeyBytes();
  if (!key) {
    if (!warnedNoKey && process.env.NODE_ENV === 'production') {
      warnedNoKey = true;
      console.error('[SECRET-BOX] TOTP_SECRET_KEY is not set — 2FA secrets are being stored in plaintext.');
    }
    return plain;
  }
  if (typeof crypto?.subtle !== 'undefined') {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ck = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, enc.encode(plain)));
    // WebCrypto appends the 16-byte tag; the envelope stores it separately.
    return `${PREFIX}${b64u(iv)}.${b64u(ct.slice(ct.length - 16))}.${b64u(ct.slice(0, ct.length - 16))}`;
  }
  const iv = new Uint8Array(randomBytes(12));
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${b64u(iv)}.${b64u(new Uint8Array(cipher.getAuthTag()))}.${b64u(new Uint8Array(ct))}`;
}

/**
 * Open a stored secret. Values written before sealing existed (and values written
 * while no key was configured) are bare base32 and pass straight through, so
 * turning the key on does not lock anybody out of an account already enrolled.
 */
export async function decryptSecret(stored: string): Promise<string> {
  if (!stored || !stored.startsWith(PREFIX)) return stored;
  const key = await sealingKeyBytes();
  if (!key) {
    console.error('[SECRET-BOX] A sealed secret was read without TOTP_SECRET_KEY set — it cannot be opened.');
    // Throwing keeps the caller from treating a ciphertext as a secret and
    // "verifying" a code against it: the answer must be a refusal, not a maybe.
    throw new Error('sealed secret unreadable: TOTP_SECRET_KEY missing');
  }
  const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('sealed secret is malformed');
  if (typeof crypto?.subtle !== 'undefined') {
    const iv = new Uint8Array(Buffer.from(ivB64, 'base64url'));
    const tag = new Uint8Array(Buffer.from(tagB64, 'base64url'));
    const data = new Uint8Array(Buffer.from(dataB64, 'base64url'));
    const joined = new Uint8Array(data.length + tag.length);
    joined.set(data, 0);
    joined.set(tag, data.length);
    const ck = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    try {
      return dec.decode(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, joined)));
    } catch {
      throw new Error('sealed secret failed authentication');
    }
  }
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}
