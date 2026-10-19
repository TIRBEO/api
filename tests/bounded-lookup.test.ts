/**
 * Unit tests for the bounded IPv4 DNS lookup used by every pool connection.
 *
 * pg's timers (and our withDeadline wrappers) can only release the caller —
 * they cannot abort a getaddrinfo already in libuv's threadpool, which is why
 * production warm-up attempts burned 101–210s on a wedged resolver. These
 * tests pin the lookup contract that replaces that failure mode: forced
 * family 4, a hard timeout, per-host caching, and a cooldown that keeps a
 * resolver outage from burning a threadpool slot per attempt.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as net from 'net';
import { createBoundedIpv4Lookup, BoundedLookupSocket } from '../infrastructure/db/bounded-lookup';

type ManualCb = (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void;

function manualLookup() {
  const calls: Array<{ hostname: string; cb: ManualCb }> = [];
  const lookup = vi.fn((hostname: string, _options: any, cb: ManualCb) => {
    calls.push({ hostname, cb });
  });
  return { lookup, calls };
}

const COOLDOWN_ERR_CODE = 'ECOOLDOWN';

describe('createBoundedIpv4Lookup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes family 4 and reports the resolved address', async () => {
    const { lookup, calls } = manualLookup();
    const bounded = createBoundedIpv4Lookup({ lookup });
    const out = await new Promise<any>((resolve) => {
      bounded('pooler.example.com', {}, (err, address, family) => resolve({ err, address, family }));
      calls[0].cb(null, '20.1.2.3', 4);
    });
    expect(out.err).toBeNull();
    expect(out.address).toBe('20.1.2.3');
    expect(out.family).toBe(4);
    expect(lookup).toHaveBeenCalledWith('pooler.example.com', { family: 4, hints: 0 }, expect.any(Function));
  });

  it('caches a successful resolution', async () => {
    const { lookup, calls } = manualLookup();
    const bounded = createBoundedIpv4Lookup({ lookup });
    await new Promise<void>((resolve) => {
      bounded('h', {}, () => resolve());
      calls[0].cb(null, '20.2.2.2', 4);
    });
    const second = await new Promise<any>((resolve) => {
      bounded('h', {}, (err, address, family) => resolve({ err, address, family }));
    });
    expect(second.err).toBeNull();
    expect(second.address).toBe('20.2.2.2');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('returns an array when the caller asks for all addresses', async () => {
    const { lookup, calls } = manualLookup();
    const bounded = createBoundedIpv4Lookup({ lookup });
    const out = await new Promise<any>((resolve) => {
      bounded('h', { all: true }, (err, address) => resolve({ err, address }));
      calls[0].cb(null, '20.3.3.3', 4);
    });
    expect(out.address).toEqual([{ address: '20.3.3.3', family: 4 }]);
  });

  it('times out a hung lookup and suppresses the hostname during cooldown', async () => {
    vi.useFakeTimers();
    const { lookup } = manualLookup();
    const bounded = createBoundedIpv4Lookup({ lookup, timeoutMs: 30, cooldownMs: 60_000 });
    const first = new Promise<any>((resolve) => {
      bounded('h', {}, (err) => resolve(err));
    });
    await vi.advanceTimersByTimeAsync(35);
    const err = await first;
    expect(err?.code).toBe('ETIMEDOUT');
    expect(err?.message).toContain('timed out after 30ms');

    const second = await new Promise<any>((resolve) => {
      bounded('h', {}, (e) => resolve(e));
    });
    expect(second?.code).toBe(COOLDOWN_ERR_CODE);
    expect(lookup).toHaveBeenCalledTimes(1); // cooldown never touches DNS again
  });

  it('a slow-but-successful lookup heals the cooldown', async () => {
    vi.useFakeTimers();
    const { lookup, calls } = manualLookup();
    const bounded = createBoundedIpv4Lookup({ lookup, timeoutMs: 30, cooldownMs: 60_000 });
    const first = new Promise<any>((resolve) => {
      bounded('h', {}, (err) => resolve(err));
    });
    await vi.advanceTimersByTimeAsync(35);
    expect((await first)?.code).toBe('ETIMEDOUT');

    // the parked getaddrinfo finally returns — success must overwrite the cooldown
    calls[0].cb(null, '20.9.9.9', 4);

    const healed = await new Promise<any>((resolve) => {
      bounded('h', {}, (err, address) => resolve({ err, address }));
    });
    expect(healed.err).toBeNull();
    expect(healed.address).toBe('20.9.9.9');
  });

  it('propagates resolver errors and cools the host down', async () => {
    const { lookup, calls } = manualLookup();
    const bounded = createBoundedIpv4Lookup({ lookup, cooldownMs: 60_000 });
    const fail = await new Promise<any>((resolve) => {
      bounded('h', {}, (err) => resolve(err));
      const e = new Error('getaddrinfo EAI_AGAIN') as NodeJS.ErrnoException;
      e.code = 'EAI_AGAIN';
      calls[0].cb(e);
    });
    expect(fail?.code).toBe('EAI_AGAIN');

    const cooled = await new Promise<any>((resolve) => {
      bounded('h', {}, (err) => resolve(err));
    });
    expect(cooled?.code).toBe(COOLDOWN_ERR_CODE);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('honours only the first of duplicate lookup callbacks', async () => {
    const { lookup, calls } = manualLookup();
    const bounded = createBoundedIpv4Lookup({ lookup });
    const responses: any[] = [];
    bounded('h', {}, (err, address) => responses.push({ err, address }));
    calls[0].cb(null, '20.4.4.4', 4);
    calls[0].cb(null, '20.5.5.5', 4);
    expect(responses).toHaveLength(1);
    expect(responses[0].address).toBe('20.4.4.4');
  });
});

describe('BoundedLookupSocket', () => {
  it('connects through the injected lookup (family-4 options path)', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const bounded = createBoundedIpv4Lookup({
      lookup: (_h, _o, cb) => cb(null, '127.0.0.1', 4),
    });
    const socket = new BoundedLookupSocket(bounded as any);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
        // host is a fake pooler name: only the injected lookup can make this work
        socket.connect(port, 'pooler.internal');
      });
    } finally {
      socket.destroy();
      server.close();
    }
  });
});
