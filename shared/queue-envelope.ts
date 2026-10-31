import crypto from 'crypto';

/* ═══ TIRBEO QUEUE ENVELOPES — one Cloudflare Queue, typed work ═══
   The `tirbeo-api-jobs` queue carries every background task the platform
   creates: scheduled jobs, outbound email, notification fan-out. The consumer
   (apps/jobs worker) POSTs each message to an endpoint on this API with a
   HMAC envelope signature; /api/queue/drain verifies and dispatches. Queues at
   least-once, so every handler must be idempotent (email dedupe keys, job_runs
   gate, notification rate limits all already are).

   Why HMAC instead of CRON_SECRET here: the Worker signs messages with
   QUEUE_SIGNING_SECRET, but this API cannot read Cloudflare secrets — both
   sides get the same value from the deployment env, and the signature covers
   body + timestamp so a leaked envelope expires in 5 minutes anyway. */

export type QueueKind = 'job' | 'email' | 'notify' | 'mail';

export interface QueueEnvelope {
  kind: QueueKind;
  /** job: JobName · email/notify: action label · mail: templateName */
  action: string;
  payload: unknown;
  ts: number;
  nonce: string;
  sig: string;
}

const MAX_SKEW_MS = 5 * 60_000;

function canonical(en: Pick<QueueEnvelope, 'kind' | 'action' | 'payload' | 'ts' | 'nonce'>): string {
  return `${en.kind}|${en.action}|${JSON.stringify(en.payload)}|${en.ts}|${en.nonce}`;
}

/* Skew guard (learned the hard way): a box whose clock is minutes behind — or
   an HTTP Date header rounded to whole seconds — can stamp `ts` after the
   verifier's now. |ts - now| stays inside the window, but a signed envelope is
   immutable once handed to Cloudflare Queues, so a future-leaning stamp that
   ages into the 5-minute band would poison the message through every retry and
   land it in the DLQ. Half the window of headroom fixes both cases without
   letting anyone sign far-future envelopes. */
const MAX_FUTURE_MS = 150_000;

async function hmac(secret: string, msg: string): Promise<string> {
  if (typeof crypto.subtle !== 'undefined') {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
    return Buffer.from(new Uint8Array(sig)).toString('hex');
  }
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
}

/** Sign an envelope for enqueueing (API side, Node). */
export async function signEnvelope<T extends QueueKind>(kind: T, action: string, payload: unknown): Promise<QueueEnvelope> {
  const secret = process.env.QUEUE_SIGNING_SECRET || '';
  if (!secret) throw new Error('QUEUE_SIGNING_SECRET is not set');
  const base = { kind, action, payload, ts: Date.now(), nonce: crypto.randomUUID() };
  const sig = await hmac(secret, canonical(base));
  return { ...base, sig };
}

/** Verify a received envelope (Worker or API side, WebCrypto-compatible). */
export async function verifyEnvelope(env: Partial<QueueEnvelope> | null): Promise<QueueEnvelope | null> {
  const secret = process.env.QUEUE_SIGNING_SECRET || '';
  if (!secret || !env || typeof env.kind !== 'string' || typeof env.action !== 'string') return null;
  if (typeof env.ts !== 'number') return null;
  const age = Date.now() - env.ts;
  if (age < -MAX_FUTURE_MS || age > MAX_SKEW_MS) return null;
  if (typeof env.nonce !== 'string' || typeof env.sig !== 'string' || !/^[0-9a-f]{64}$/.test(env.sig)) return null;
  const expected = await hmac(secret, canonical(env as any));
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(env.sig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return env as QueueEnvelope;
}
