import { argon2id } from '@noble/hashes/argon2.js';
import { randomBytes as nodeRandomBytes } from 'crypto';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

/* Password hashes must verify identically wherever they were minted — this box
   (native argon2 addon) or Cloudflare Workers (no native addons allowed). So
   hashing runs on @noble/hashes' pure-JS argon2id, which produces byte-identical
   output to the reference C implementation: same $argon2id$v=19$m=65536,p=1,t=3
   PHC strings, old hashes keep verifying, and new ones work on both runtimes.

   Cost params are frozen at the values every Tirbeo hash has carried since day
   one; changing them would silently lock everyone out of verify(). */

const MEMORY_COST = 2 ** 16; // KiB → 64 MiB
const TIME_COST = 3;
const PARALLELISM = 1;
const HASH_LEN = 32;
const SALT_LEN = 16;

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function b64(buf: Uint8Array): string {
  // PHC strings carry unpadded base64 — match what the reference C encoder writes.
  return Buffer.from(buf).toString('base64').replace(/=+$/, '');
}

/** Decode a PHC base64 field. Padding is optional there (argon2 reference
    strips '='), so canonicality is checked against the padded form. */
function unB64(salt: string): Uint8Array | null {
  if (!B64_RE.test(salt)) return null;
  const raw = Buffer.from(salt, 'base64');
  // Reject garbage that merely happens to decode: re-encoded, with any input
  // padding removed, must reproduce the input.
  return Buffer.from(raw).toString('base64').replace(/=+$/, '') === salt.replace(/=+$/, '')
    ? new Uint8Array(raw)
    : null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(nodeRandomBytes(SALT_LEN));
  const hash = argon2id(new TextEncoder().encode(password), salt, {
    m: MEMORY_COST, t: TIME_COST, p: PARALLELISM, dkLen: HASH_LEN,
  });
  return `$argon2id$v=19$m=${MEMORY_COST},p=${PARALLELISM},t=${TIME_COST}$${b64(salt)}$${b64(hash)}`;
}

/** Constant-time compare of equal-length buffers (lengths pre-checked). */
function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    const segs = hash.split('$'); // ['', 'argon2id', 'v=19', 'm=…,p=…,t=…', salt, hash]
    if (segs.length !== 6 || segs[1] !== 'argon2id' || segs[2] !== 'v=19') return false;
    const params = new Map(segs[3].split(',').map((kv) => kv.split('=') as [string, string]));
    const m = Number(params.get('m'));
    const t = Number(params.get('t'));
    const p = Number(params.get('p'));
    if (!Number.isFinite(m) || !Number.isFinite(t) || !Number.isFinite(p) || m <= 0 || t <= 0 || p <= 0) return false;
    const salt = unB64(segs[4]);
    const want = unB64(segs[5]);
    if (!salt || !want) return false;
    const got = argon2id(new TextEncoder().encode(password), salt, { m, t, p, dkLen: want.length });
    return constantTimeEquals(got, want);
  } catch {
    return false;
  }
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/-/g, '');
}

function hmacSha256Hex(key: string, data: string): string {
  const digest = hmac(sha256, new TextEncoder().encode(key), new TextEncoder().encode(data));
  return Buffer.from(digest).toString('hex');
}

export function hashRecoveryCode(code: string): string {
  const pepper = process.env.RECOVERY_PEPPER;
  if (!pepper) {
    throw new Error('RECOVERY_PEPPER environment variable is required');
  }
  return hmacSha256Hex(pepper, normalizeRecoveryCode(code));
}

export function hashOtpCode(code: string): string {
  const pepper = process.env.OTP_PEPPER;
  if (!pepper) {
    throw new Error('OTP_PEPPER environment variable is required');
  }
  return hmacSha256Hex(pepper, code);
}

export async function verifyOtpCode(hash: string, code: string): Promise<boolean> {
  const pepper = process.env.OTP_PEPPER;
  if (!pepper) {
    throw new Error('OTP_PEPPER environment variable is required');
  }
  const expected = hmacSha256Hex(pepper, code);
  return constantTimeEquals(new TextEncoder().encode(hash), new TextEncoder().encode(expected));
}
