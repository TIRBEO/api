import nodeCrypto from 'crypto';
import { getRedis } from './redis';

/**
 * ptr — a page-proof token.
 *
 * Every successful auth "send" (magic link, login OTP, password reset) issues
 * an opaque 24-hex key bound to the email, the method and the device that
 * asked. Any later send for that pair must present the live key — so a leaked
 * /magic-sent URL cannot be re-run from another device, and the resend
 * endpoints stop being a free email cannon. Keys are 96-bit random and expire
 * with the 15-minute link lifetime; wrong guesses are counted per IP by the
 * caller.
 */

const PTR_TTL_MS = 15 * 60 * 1000;

interface PtrRec {
  email: string;
  method: string;
  device: string;
  issuedAt: number;
}

function redisSafe(): any {
  try { return getRedis() || null; } catch { return null; }
}

/* Redis-first with process-global mirrors, same convention as verify-limits:
   dev without Redis still gets working (per-process) enforcement.

   Why the non-Redis fallback is the in-process mirror and NOT the Otp table
   (unlike the passkey challenge, which fits there): a ptr is an opaque
   capability that checkPtr compares BY VALUE (bodyPtr === active) and uses to
   look up a separate flow's record by its raw token to reconcile an
   email-mismatch guess. Otp.otpHash is a hash column keyed by (kind, address);
   hashing the ptr makes value-comparison and by-ptr retrieval impossible, and
   storing the raw ptr there would be strictly worse than the existing Redis
   store (which already holds it in cleartext). issuePtr is also synchronous by
   contract. The proof shape can't fit losslessly, so the mirror stays the
   fallback — ptr only guards resends within a single browser session's flow. */
const vals = ((globalThis as any).__ptrVals ||= new Map<string, { rec: PtrRec; expiresAt: number }>());
const idxs = ((globalThis as any).__ptrIdx ||= new Map<string, { ptr: string; expiresAt: number }>());

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of vals) if (v.expiresAt <= now) vals.delete(k);
  for (const [k, v] of idxs) if (v.expiresAt <= now) idxs.delete(k);
}

const idxKey = (method: string, email: string) => `ptr:idx:${method}:${email.toLowerCase()}`;
const valKey = (ptr: string) => `ptr:${ptr}`;

/** Coarse but stable device id: the client's __dfp fingerprint when present,
 *  else a hash of the User-Agent. */
export function ptrDeviceId(ua: string | null, dfp: string | null): string {
  const src = (dfp && dfp.trim()) || (ua && ua.trim()) || 'unknown';
  return (nodeCrypto as any).createHash('sha256').update(src).digest('hex').slice(0, 16);
}

export function issuePtr(method: string, email: string, device: string): string {
  const ptr = (nodeCrypto as any).randomBytes(12).toString('hex') as string;
  const rec: PtrRec = { email: email.toLowerCase(), method, device, issuedAt: Date.now() };
  sweep();
  // Retire the previous key for this pair so only one flow is ever live;
  // otherwise every restart leaks an orphaned record until its TTL runs out.
  const prev = idxs.get(idxKey(method, email));
  if (prev) vals.delete(valKey(prev.ptr));
  vals.set(valKey(ptr), { rec, expiresAt: Date.now() + PTR_TTL_MS });
  idxs.set(idxKey(method, email), { ptr, expiresAt: Date.now() + PTR_TTL_MS });
  const r = redisSafe();
  if (r) {
    if (prev && prev.ptr !== ptr) r.del(valKey(prev.ptr)).catch(() => {});
    r.set(valKey(ptr), JSON.stringify(rec), 'PX', PTR_TTL_MS).catch(() => {});
    r.set(idxKey(method, email), ptr, 'PX', PTR_TTL_MS).catch(() => {});
  }
  return ptr;
}

async function readIdxPtr(method: string, email: string): Promise<string | null> {
  const r = redisSafe();
  if (r) {
    try {
      const v = await r.get(idxKey(method, email));
      if (typeof v === 'string' && v) return v;
    } catch {}
  }
  sweep();
  const m = idxs.get(idxKey(method, email));
  return m ? m.ptr : null;
}

async function readRec(ptr: string): Promise<PtrRec | null> {
  const r = redisSafe();
  if (r) {
    try {
      const v = await r.get(valKey(ptr));
      if (typeof v === 'string' && v) return JSON.parse(v);
    } catch {}
  }
  sweep();
  const m = vals.get(valKey(ptr));
  return m ? m.rec : null;
}

export type PtrCheck =
  | { state: 'no-active' }
  | { state: 'ok' }
  | { state: 'restart' }
  | { state: 'invalid'; reason: 'missing' | 'unknown' | 'email' | 'device' };

/**
 * Gate a send. No live ptr for (method, email) → first request: allow, and the
 * caller issues one after a successful send. Live ptr → the request must
 * present it, from the device that started the flow.
 *
 * A request with no key at all is not treated as an attack when it comes from
 * the device that holds the live flow: that is a user who lost the key (new
 * tab, cleared storage, a page reload mid-flow) and is honestly starting over.
 * Telling them 403 "use the original link, or start again" while the stale key
 * sits in Redis for its whole 15-minute lifetime made "start again" impossible
 * and the reset flow a dead end. Cross-device replay — the case the gate
 * actually exists for — still fails the device comparison below.
 */
export async function checkPtr(method: string, email: string, bodyPtr: unknown, device: string): Promise<PtrCheck> {
  const active = await readIdxPtr(method, email);
  if (!active) return { state: 'no-active' };
  if (typeof bodyPtr !== 'string' || !bodyPtr) {
    const rec = await readRec(active);
    if (rec && rec.device === device) return { state: 'restart' };
    return { state: 'invalid', reason: 'missing' };
  }
  if (!/^[a-f0-9]{24}$/.test(bodyPtr) || bodyPtr !== active) {
    // A wrong-shaped or wrong guess: same verdict, no oracle on which part
    // failed beyond device-vs-unknown.
    const rec = /^[a-f0-9]{24}$/.test(bodyPtr || '') ? await readRec(bodyPtr as string) : null;
    if (!rec) {
      // An unknown key is usually the client holding one the server has since
      // dropped (a dev restart, or a release after the flow completed). If the
      // live flow belongs to this same device, that is a restart, not a
      // replay — the client would otherwise keep offering the dead key and
      // bounce off 403 until the old flow's TTL ran out.
      const live = await readRec(active);
      if (live && live.device === device) return { state: 'restart' };
      return { state: 'invalid', reason: 'unknown' };
    }
    if (rec.email !== email.toLowerCase()) return { state: 'invalid', reason: 'email' };
    return { state: 'invalid', reason: 'unknown' };
  }
  const rec = await readRec(active);
  if (!rec) return { state: 'invalid', reason: 'unknown' };
  if (rec.email !== email.toLowerCase()) return { state: 'invalid', reason: 'email' };
  if (rec.device !== device) return { state: 'invalid', reason: 'device' };
  return { state: 'ok' };
}

/** Drop the live ptr — used when a send fails after the check passed, so the
 *  next attempt is treated as a fresh first request. */
export async function releasePtr(method: string, email: string, ptr: string): Promise<void> {
  vals.delete(valKey(ptr));
  const cur = idxs.get(idxKey(method, email));
  if (cur && cur.ptr === ptr) idxs.delete(idxKey(method, email));
  const r = redisSafe();
  if (r) {
    try {
      await r.del(valKey(ptr));
      const live = await r.get(idxKey(method, email));
      if (live === ptr) await r.del(idxKey(method, email));
    } catch {}
  }
}

export function ptrErrorBody(reason: 'missing' | 'unknown' | 'email' | 'device'): { error: string } {
  const msg =
    reason === 'device'
      ? 'This action must be confirmed from the device that started it.'
      : reason === 'missing'
        ? 'This action needs the key from the page you were sent to. Use the original link, or start again.'
        : 'The key for this action is not valid. Start again from the sign-in page.';
  return { error: msg };
}
