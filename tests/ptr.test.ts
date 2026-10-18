/**
 * Unit tests for the ptr (page-proof token) send gate.
 *
 * The gate exists so a leaked "send" URL cannot be replayed from another
 * device, but it must not turn a lost key on the *starting* device into a
 * 15-minute dead end — which is the failure that made the password-reset flow
 * unusable. Redis is stubbed off, so these exercise the process-global mirror.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../features/auth/redis', () => ({ getRedis: () => null }));

const { checkPtr, issuePtr, releasePtr } = await import('../features/auth/ptr');

const DEVICE_A = 'a'.repeat(16);
const DEVICE_B = 'b'.repeat(16);

describe('ptr send gate', () => {
  it('allows the first send of a pair with no key', async () => {
    const res = await checkPtr('t:first', 'First@Example.com', undefined, DEVICE_A);
    expect(res.state).toBe('no-active');
  });

  it('accepts a resend that presents the live key from the same device', async () => {
    const ptr = issuePtr('t:ok', 'ok@example.com', DEVICE_A);
    const res = await checkPtr('t:ok', 'Ok@Example.com', ptr, DEVICE_A);
    expect(res).toEqual({ state: 'ok' });
  });

  it('rejects a resend from a different device that presents the key', async () => {
    const ptr = issuePtr('t:device', 'dev@example.com', DEVICE_A);
    const res = await checkPtr('t:device', 'dev@example.com', ptr, DEVICE_B);
    expect(res).toEqual({ state: 'invalid', reason: 'device' });
  });

  it('lets the starting device begin again after losing the key', async () => {
    issuePtr('t:restart', 'rs@example.com', DEVICE_A);
    // New tab / cleared storage / reload mid-flow: no key, same device.
    const res = await checkPtr('t:restart', 'rs@example.com', undefined, DEVICE_A);
    expect(res.state).toBe('restart');
  });

  it('lets any device start over when it presents no key at all', async () => {
    // A missing key proves nothing — refusing it dead-ended honest users
    // (new tab, phone↔laptop) for the key's whole TTL. Send volume is capped
    // by the per-email/per-IP limits in the callers instead.
    issuePtr('t:steal', 'steal@example.com', DEVICE_A);
    const res = await checkPtr('t:steal', 'steal@example.com', '', DEVICE_B);
    expect(res.state).toBe('restart');
  });

  it('retires the previous key when a restart issues a new one', async () => {
    const stale = issuePtr('t:rotate', 'rot@example.com', DEVICE_A);
    const fresh = issuePtr('t:rotate', 'rot@example.com', DEVICE_A);
    expect(fresh).not.toBe(stale);
    // A dead key is an out-of-step client, wherever it came from: restart.
    expect(await checkPtr('t:rotate', 'rot@example.com', stale, DEVICE_A)).toEqual({ state: 'restart' });
    expect(await checkPtr('t:rotate', 'rot@example.com', stale, DEVICE_B)).toEqual({ state: 'restart' });
  });

  it('treats a released pair as a fresh first request', async () => {
    const ptr = issuePtr('t:release', 'rel@example.com', DEVICE_A);
    await releasePtr('t:release', 'rel@example.com', ptr);
    const res = await checkPtr('t:release', 'rel@example.com', undefined, DEVICE_B);
    expect(res.state).toBe('no-active');
  });

  it('matches the email of the live key', async () => {
    const ptr = issuePtr('t:email', 'a@example.com', DEVICE_A);
    // Same key, different address: the index for b@ has no entry, so this is a
    // legitimate first request there — the gate never leaks a@'s flow to b@.
    const res = await checkPtr('t:email', 'b@example.com', ptr, DEVICE_A);
    expect(res.state).toBe('no-active');
  });
});
