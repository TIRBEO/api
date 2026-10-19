// ─── Bounded IPv4 DNS lookup for pool connections ───
// pg's connectionTimeoutMillis (and our withDeadline wrappers) can only
// reject the *caller* — they cannot abort a getaddrinfo already running in
// libuv's threadpool. Production logs showed warm-up attempts giving up after
// 101s, 150s, 210s (and historically 594s/1024s) with "Connection terminated
// due to connection timeout": the pooler's AAAA resolution hung, the pg timer
// destroyed the socket seconds later, and the late getaddrinfo error was
// wrapped minutes after the caller had given up. A hung lookup also parks one
// of the four uv threadpool slots, so enough of them stall unrelated DNS for
// every request in the isolate.
//
// The only layer that can bound DNS is our own: pg hands a custom `stream`
// straight into net.Socket (pg/lib/connection.js calls
// `stream.connect(port, host)`), and net.connect options accept a `lookup`
// function. Every pool connection therefore resolves through this lookup:
// forced family 4 (the pooler's AAAA path is the one that hangs; its A
// records are stable), a 3s hard timeout, and a per-host cache so a resolver
// outage fails fast in milliseconds instead of burning a threadpool slot per
// attempt.
import * as dns from 'dns';
import * as net from 'net';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | dns.LookupAddress[],
  family?: number,
) => void;

type LookupFn = (
  hostname: string,
  options: { family?: number; hints?: number; all?: boolean },
  callback: (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void,
) => void;

export interface BoundedLookupOptions {
  /** Injectable for tests; defaults to dns.lookup. */
  lookup?: LookupFn;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** How long a failed/timed-out hostname short-circuits subsequent lookups. */
  cooldownMs?: number;
}

export function createBoundedIpv4Lookup(
  options: BoundedLookupOptions = {},
): (hostname: string, lookupOptions: { all?: boolean } | undefined, callback: LookupCallback) => void {
  const lookupFn: LookupFn = options.lookup ?? (dns.lookup as unknown as LookupFn);
  const timeoutMs = options.timeoutMs ?? 3_000;
  const cacheTtlMs = options.cacheTtlMs ?? 10 * 60_000;
  const cooldownMs = options.cooldownMs ?? 15_000;
  const cache = new Map<string, { kind: 'ok'; address: string; expiresAt: number } | { kind: 'fail'; until: number }>();

  return function boundedLookup(
    hostname: string,
    lookupOptions: { all?: boolean } | undefined,
    callback: LookupCallback,
  ): void {
    const wantsAll = !!lookupOptions?.all;
    let settled = false;
    const finish = (err: NodeJS.ErrnoException | null, address?: string): void => {
      if (settled) return;
      settled = true;
      if (err) callback(err);
      else if (wantsAll) callback(null, [{ address: address as string, family: 4 }]);
      else callback(null, address, 4);
    };

    const cached = cache.get(hostname);
    const now = Date.now();
    if (cached) {
      if (cached.kind === 'ok' && cached.expiresAt > now) {
        finish(null, cached.address);
        return;
      }
      if (cached.kind === 'fail' && cached.until > now) {
        const err = new Error(
          `DNS lookup for ${hostname} suppressed for ${Math.ceil((cached.until - now) / 1000)}s (cooldown after an earlier failure)`,
        ) as NodeJS.ErrnoException;
        err.code = 'ECOOLDOWN';
        finish(err);
        return;
      }
      cache.delete(hostname);
    }

    const timer = setTimeout(() => {
      cache.set(hostname, { kind: 'fail', until: Date.now() + cooldownMs });
      const err = new Error(`DNS lookup for ${hostname} timed out after ${timeoutMs}ms`) as NodeJS.ErrnoException;
      err.code = 'ETIMEDOUT';
      finish(err);
    }, timeoutMs);
    // The timeout only needs to fire while the isolate is doing other work;
    // never let it alone keep a process alive at shutdown.
    timer.unref?.();

    lookupFn(hostname, { family: 4, hints: 0 }, (err, address) => {
      clearTimeout(timer);
      const addr = typeof address === 'string' ? address : Array.isArray(address) ? address[0]?.address : undefined;
      if (settled) {
        // The timeout already reported this lookup. A slow-but-successful
        // result still heals the cooldown so the next connect is instant.
        if (!err && addr) cache.set(hostname, { kind: 'ok', address: addr, expiresAt: Date.now() + cacheTtlMs });
        return;
      }
      if (err) {
        cache.set(hostname, { kind: 'fail', until: Date.now() + cooldownMs });
        finish(err);
        return;
      }
      if (!addr) {
        cache.set(hostname, { kind: 'fail', until: Date.now() + cooldownMs });
        const notFound = new Error(`DNS lookup for ${hostname} returned no address`) as NodeJS.ErrnoException;
        notFound.code = 'ENOTFOUND';
        finish(notFound);
        return;
      }
      cache.set(hostname, { kind: 'ok', address: addr, expiresAt: Date.now() + cacheTtlMs });
      finish(null, addr);
    });
  };
}

/** net.Socket whose connect() resolves through a bounded IPv4 lookup. */
export class BoundedLookupSocket extends net.Socket {
  private readonly lookupFn: (hostname: string, options: any, callback: LookupCallback) => void;

  constructor(lookupFn: (hostname: string, options: any, callback: LookupCallback) => void) {
    super();
    this.lookupFn = lookupFn;
  }

  // Match net.Socket's overloads so pg's `stream.connect(port, host)` type
  // checks; the options-object and unix-socket forms pass through.
  connect(options: net.SocketConnectOpts, connectionListener?: () => void): this;
  connect(port: number, host: string, connectionListener?: () => void): this;
  connect(port: number, connectionListener?: () => void): this;
  connect(path: string, connectionListener?: () => void): this;
  connect(...args: any[]): this {
    const [first, second, third] = args;
    if (typeof first === 'object' && first !== null) {
      return super.connect({ ...(first as object), family: 4, autoSelectFamily: false, lookup: this.lookupFn } as net.SocketConnectOpts, second);
    }
    if (typeof first === 'string' && Number.isNaN(Number(first))) {
      // unix socket path — no DNS involved
      return super.connect(first, second);
    }
    const host = typeof second === 'string' ? second : 'localhost';
    const listener = typeof second === 'function' ? second : third;
    return super.connect(
      {
        port: first as number,
        host,
        family: 4,
        autoSelectFamily: false,
        lookup: this.lookupFn,
      } as net.SocketConnectOpts,
      listener,
    );
  }
}
