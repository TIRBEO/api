import { signEnvelope } from '@/shared/queue-envelope';

/* Enqueue background work onto Cloudflare Queues through the jobs worker's
   HTTP front (`POST /enqueue`). Fire-and-forget by design: if the queue or the
   worker is unreachable, callers fall back to doing the work inline — losing
   speed, never correctness. Requires QUEUE_ENQUEUE_URL + QUEUE_SIGNING_SECRET;
   unset means "queues off", which keeps self-hosted/dev installs unchanged. */

export async function enqueueWork(kind: 'job' | 'email' | 'notify' | 'mail' | 'reco', action: string, payload: unknown): Promise<boolean> {
  const url = process.env.QUEUE_ENQUEUE_URL;
  if (!url || !process.env.QUEUE_SIGNING_SECRET) return false;
  try {
    const envelope = await signEnvelope(kind as any, action, payload);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[QUEUE] enqueue ${kind}:${action} → ${res.status}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`[QUEUE] enqueue ${kind}:${action} failed:`, err?.message || err);
    return false;
  }
}
