import { describe, it, expect } from 'vitest';
import { signEnvelope, verifyEnvelope } from '@/shared/queue-envelope';

describe('queue envelopes', () => {
  process.env.QUEUE_SIGNING_SECRET = 'test-signing-secret';

  it('signs and verifies a round trip', async () => {
    const env = await signEnvelope('job', 'cleanup', { due: true });
    expect(await verifyEnvelope(env)).toBeTruthy();
  });

  it('rejects a tampered payload', async () => {
    const env = await signEnvelope('mail', 'welcome', { to: 'a@b.c' });
    (env as any).payload = { to: 'victim@x.y' };
    expect(await verifyEnvelope(env)).toBeNull();
  });

  it('rejects a stale envelope (>5 min)', async () => {
    const env = await signEnvelope('notify', 'deliver', { notificationId: 'n1' });
    (env as any).ts = Date.now() - 6 * 60_000;
    // recompute nothing — the timestamp is inside the signed canonical string
    expect(await verifyEnvelope(env)).toBeNull();
  });

  it('rejects forged signatures and garbage shapes', async () => {
    expect(await verifyEnvelope(null)).toBeNull();
    expect(await verifyEnvelope({ kind: 'job', action: 'x', payload: 1, ts: Date.now(), nonce: 'n', sig: 'zz'.repeat(32) } as any)).toBeNull();
    expect(await verifyEnvelope({ kind: 'job', action: 'x', payload: 1, ts: Date.now(), nonce: 'n', sig: '0'.repeat(64) } as any)).toBeNull();
  });

  it('missing secret fails closed on both sides', async () => {
    const saved = process.env.QUEUE_SIGNING_SECRET;
    delete process.env.QUEUE_SIGNING_SECRET;
    await expect(signEnvelope('job', 'cleanup', {})).rejects.toThrow(/QUEUE_SIGNING_SECRET/);
    const forged = { kind: 'job' as const, action: 'cleanup', payload: {}, ts: Date.now(), nonce: 'n', sig: '0'.repeat(64) };
    expect(await verifyEnvelope(forged)).toBeNull();
    process.env.QUEUE_SIGNING_SECRET = saved;
  });
});
