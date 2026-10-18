import nodeCrypto from 'crypto';
import { getRedis } from './redis';

/**
 * ptr — a page-proof token.
 *
 * Every successful auth "send" (magic link, login OTP, password reset) issues
 * an opaque 24-hex key bound to the email, the method and the device that
 * asked. A resend that presents the live key from a foreign device is refused
 * — that is the replay the gate exists to stop. A resend with no key (or a
 * stale one) is allowed as a fresh start: with no client ever setting the
 * __dfp cookie, the device signal is only a UA hash, and refusing these
 * locked honest users out of their own reset flow. Email volume is capped by
 * the per-email/per-IP limits in the callers. Keys are 96-bit random and
 * expire with the 15-minute link lifetime; wrong guesses are counted per IP
 * by the caller.
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
 * caller issues one after a successful send. Live ptr + a key in the body →
 * the key must match. A request with NO key at all is a restart, always.
 *
 * A missing key proves nothing about who is asking — it is what every honest
 * client sends after losing the key (new tab, cleared storage, a phone/laptop
 * switch, any UA drift), because the device signal is only a UA hash: nothing
 * ever sets the __dfp cookie. 403-ing those made "start again" impossible
 * until the stale key's 15-minute TTL ran out and turned the reset flow into
 * a dead end, while anyone willing to wait (or to simply start a fresh flow
 * for a different address) bypassed the block anyway. Send volume stays
 * capped by the per-email/per-IP limits every caller applies. The one signal
 * that still gets refused: the LIVE key arriving from a foreign device, or a
 * key belonging to a different address — genuine replays of a forwarded flow.
 */
export async function checkPtr(method: string, email: string, bodyPtr: unknown, device: string): Promise<PtrCheck> {
  const active = await readIdxPtr(method, email);
  if (!active) return { state: 'no-active' };
  if (typeof bodyPtr !== 'string' || !bodyPtr) return { state: 'restart' };
  if (!/^[a-f0-9]{24}$/.test(bodyPtr) || bodyPtr !== active) {
    // A wrong-shaped key, an unknown one, or a retired one from this same
    // flow (two tabs, a rotation): all mean the client is out of step, not
    // that it is replaying somebody else's live flow — only a key that
    // resolves to a *different address* proves that. Restart, and the send
    // rotates a fresh key the client can keep up with.
    const rec = /^[a-f0-9]{24}$/.test(bodyPtr) ? await readRec(bodyPtr) : null;
    if (rec && rec.email !== email.toLowerCase()) return { state: 'invalid', reason: 'email' };
    return { state: 'restart' };
  }
  // The live key, presented here: the only strong signal in the system.
  // Wrong device with the right key = replay of a forwarded flow — refuse.
  const rec = await readRec(active);
  if (!rec) return { state: 'restart' }; // idx/val desync — refuse to dead-end the client
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
