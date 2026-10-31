import { createHash } from 'crypto';

/* ═══════════════════════════════════════════════════════════════════════
   Upstash-compatible Redis over HTTP — the same surface, no TCP socket.

   Why this exists: ioredis holds a TCP connection open per instance. On
   serverless (Vercel) that means a fresh handshake on cold starts and idle
   sockets torn down by the provider every minute — the reconnect churn this
   module replaces with one keep-alive HTTPS connection per region. Upstash's
   REST proxy answers the exact commands Tirbeo uses, so `getCachedRedisClient`
   below can hand out this object instead of an ioredis client without a single
   call site changing.

   Latency reality: from Nepal, the regional proxy (~60–120 ms) beats a
   connection you must first establish (~300 ms + TLS). Within a warm Node
   process, plain ioredis-over-TCP stays faster — so the factory prefers it and
   only falls back to HTTP when `REDIS_HTTP=force` or the TCP client cannot be
   built. Failures here are always safe: every consumer already treats a
   throwing/falsey Redis as "fall back to memory/Postgres".

   Commands implemented (the complete set used across the fleet):
     get, set(+EX/PX), setex, del, incr, expire, ttl, pttl, ping, quit,
     multi().incr().pexpire().exec()  →  one pipelined request
     eval(lua, n, ...keys, ...args)    →  the two fixed-window scripts, emulated
                                          atomically-enough via pipeline+WATCH-
                                          free sequence (INCR/PTTL/PEXPIRE)
   Everything else throws (consumers degrade on purpose).
   ═══════════════════════════════════════════════════════════════════════ */

export interface HttpRedisOptions {
  /** redis://user:pass@host:port or rediss://… — reused verbatim for creds. */
  url: string;
  /** Optional explicit REST base; defaults to https://<host> */
  restBase?: string;
}

interface ParsedUrl {
  host: string;
  username: string;
  password: string;
  tls: boolean;
}

function parseRedisUrl(url: string): ParsedUrl | null {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      tls: u.protocol.startsWith('rediss') || u.protocol === 'https:',
    };
  } catch {
    return null;
  }
}

/** Upstash hosts its REST proxy at the same hostname as the TCP endpoint. */
function restBaseFor(parsed: ParsedUrl, override?: string): string {
  if (override) return override.replace(/\/+$/, '');
  const scheme = parsed.tls ? 'https' : 'http';
  return `${scheme}://${parsed.host}`;
}

async function command(base: string, auth: string, args: (string | number)[]): Promise<any> {
  const res = await fetch(`${base}/${args.map((a) => encodeURIComponent(String(a))).join('/')}`, {
    method: 'POST',
    headers: { authorization: auth },
    // Keep-alive is Node's default for fetch; one warm HTTPS path per client.
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`redis-http ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json(); // Upstash REST returns the RESP reply as JSON
}

class MultiChain {
  private queue: (string | number)[][] = [];
  constructor(private run: (tx: (string | number)[][]) => Promise<any[]>) {}
  incr(key: string) { this.queue.push(['INCR', key]); return this; }
  pexpire(key: string, ms: number) { this.queue.push(['PEXPIRE', key, ms]); return this; }
  expire(key: string, sec: number) { this.queue.push(['EXPIRE', key, sec]); return this; }
  set(key: string, value: string, mode?: string, ttl?: number) {
    this.queue.push(mode && ttl ? ['SET', key, value, mode, ttl] : ['SET', key, value]);
    return this;
  }
  hset(key: string, field: string, value: string) { this.queue.push(['HSET', key, field, value]); return this; }
  del(...keys: string[]) { this.queue.push(['DEL', ...keys]); return this; }
  async exec(): Promise<[error: Error | null, reply: any][]> {
    const replies = await this.run(this.queue);
    return this.queue.map((_, i) => [null, replies[i]]);
  }
}

export function createHttpRedisClient(name: string, options: HttpRedisOptions): any {
  const parsed = parseRedisUrl(options.url);
  if (!parsed) throw new Error(`[REDIS-${name}] unparseable REDIS_URL for HTTP client`);
  const base = restBaseFor(parsed, options.restBase);
  const auth = 'Basic ' + Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64');
  const state = { okCount: 0, errCount: 0, lastError: '' };

  const send = (...args: (string | number)[]) => command(base, auth, args);
  // A transaction = several commands in one HTTP round trip (Upstash /pipeline).
  const sendTx = async (tx: (string | number)[][]) => {
    const res = await fetch(`${base}/pipeline`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(tx),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`redis-http pipeline ${res.status}`);
    const out: any[] = await res.json();
    return out.map((r) => (r && typeof r === 'object' && 'result' in r ? r.result : r));
  };

  const client: any = {
    __transport: 'upstash-http',
    get status() { return state.errCount > 0 && state.okCount === 0 ? 'end' : 'ready'; },

    async get(key: string) { state.okCount++; return send('GET', key); },
    /** GETDEL is atomic server-side; the pipeline keeps read+delete one round trip. */
    async getdel(key: string) { state.okCount++; const r = await sendTx([['GET', key], ['DEL', key]]); return r[0]; },
    /** Supports ioredis's `set(key, val, 'EX'|'PX', n)` shape. */
    async set(key: string, value: string, mode?: string, ttl?: number) {
      state.okCount++;
      return mode && ttl ? send('SET', key, value, mode, ttl) : send('SET', key, value);
    },
    async setex(key: string, seconds: number, value: string) { state.okCount++; return send('SETEX', key, seconds, value); },
    async del(...keys: string[]) { state.okCount++; return keys.length === 1 && Array.isArray(keys[0]) ? send('DEL', ...(keys[0] as unknown as string[])) : send('DEL', ...keys); },
    async incr(key: string) { state.okCount++; return send('INCR', key); },
    async expire(key: string, sec: number) { state.okCount++; return send('EXPIRE', key, sec); },
    async pexpire(key: string, ms: number) { state.okCount++; return send('PEXPIRE', key, ms); },
    async ttl(key: string) { state.okCount++; return send('TTL', key); },
    async pttl(key: string) { state.okCount++; return send('PTTL', key); },
    async hget(key: string, field: string) { state.okCount++; return send('HGET', key, field); },
    async hset(key: string, ...args: any[]) {
      state.okCount++;
      // ioredis shapes: hset(key, field, value) or hset(key, {field: value})
      if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
        const flat: (string | number)[] = ['HSET', key];
        for (const [f, v] of Object.entries(args[0] as Record<string, unknown>)) flat.push(f, String(v));
        return send(...flat);
      }
      return send('HSET', key, ...args.map((a) => String(a)));
    },
    async hgetall(key: string) {
      state.okCount++;
      const flat: string[] = await send('HGETALL', key);
      const out: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
      return out;
    },
    async hdel(key: string, ...fields: string[]) { state.okCount++; return send('HDEL', key, ...fields); },
    async ping() { state.okCount++; return send('PING'); },
    /** Pub/sub has no REST equivalent; subscriber-side cache invalidation is
        the fallback, so this resolves quietly instead of throwing mid-delete. */
    async publish() { return 0; },
    async quit() { return 'OK'; },
    disconnect() { /* nothing to close — fetch pools manage themselves */ },

    multi() { return new MultiChain(sendTx); },

    /**
     * The fleet ships exactly two Lua scripts (fixed-window INCR+PEXPIRE+PTTL
     * and its read-only PEEK twin). Emulating them as one pipelined round trip
     * keeps the semantics callers rely on — count + remaining TTL — without a
     * EVAL-capable server. Race window: two concurrent first-hits could both
     * arm the expiry; the counter itself stays correct because INCR is atomic
     * server-side. Rate limits tolerate ±1; spent-token checks never use eval.
     */
    async eval(script: string, numKeys: number, ...rest: any[]) {
      state.okCount++;
      const keys = rest.slice(0, numKeys);
      const argv = rest.slice(numKeys).map(String);
      const normalized = script.replace(/\s+/g, ' ').trim();
      const upper = normalized.toUpperCase();

      // GETDEL twin: `local x = GET(k) if x then DEL(k) end return x or ''`
      if (/REDIS\.CALL\('GET'/.test(upper) && /REDIS\.CALL\('DEL'/.test(upper) && !/INCR|HSET/.test(upper)) {
        const r = await sendTx([['GET', String(keys[0])], ['DEL', String(keys[0])]]);
        return r[0] ?? '';
      }

      /* COOLDOWN_LUA: hash counters c/ws/ls with a fixed attempt window plus a
         per-send cooldown. Checked FIRST among the counter shapes — its body
         contains 'PEXPIRE', which would otherwise read as a plain consume-window
         script. Read-modify-write in one pipeline; the race between two
         concurrent sends costs at most one extra allowed mail — the same ±1
         tolerance documented for the counter scripts below. */
      if (/HGET/.test(upper) && /HSET/.test(upper) && keys.length === 1) {
        const key = String(keys[0]);
        const now = Number(argv[0]);
        const cdMs = Number(argv[1]);
        const winMs = Number(argv[2]);
        const maxA = Number(argv[3]);
        const ttlMs = Number(argv[4]);
        const fields: string[] = await send('HMGET', key, 'c', 'ws', 'ls').then((r: any) => r.map((v: any) => (v == null ? '0' : String(v))));
        let [c, ws, ls] = [Number(fields[0] || 0), Number(fields[1] || 0), Number(fields[2] || 0)];
        if (ws > 0 && now - ws >= winMs) { c = 0; ws = 0; }
        if (ws > 0 && c >= maxA) return [0, winMs - (now - ws), 'window'];
        if (ls > 0 && now - ls < cdMs) return [0, cdMs - (now - ls), 'cooldown'];
        const newC = c + 1;
        const newWs = ws === 0 ? now : ws;
        await sendTx([
          ['HSET', key, 'c', newC, 'ws', newWs, 'ls', now],
          ['PEXPIRE', key, ttlMs],
        ]);
        return [1, 0, ''];
      }

      const isConsume = /INCR/.test(upper) && /PEXPIRE/.test(upper);
      const isPeek = /PTTL|TTL/.test(upper) && !/INCR/.test(upper);
      if ((isConsume || isPeek) && keys.length === 1) {
        const key = String(keys[0]);
        const winMs = Number(argv[0]) || 60_000;
        if (isPeek) {
          const [count, pttl] = await Promise.all([send('GET', key), send('PTTL', key)]);
          return [Number(count) || 0, Number(pttl) || -1];
        }
        const tx = await sendTx([['INCR', key], ['PTTL', key]]);
        let [count, pttl] = [Number(tx[0]), Number(tx[1])];
        if (count === 1 || pttl < 0) { await send('PEXPIRE', key, winMs); pttl = winMs; }
        return [count, pttl];
      }

      throw new Error(`[REDIS-${name}] eval: unsupported script`);
    },

    on(_event: string, _fn: any) { /* event surface kept for compatibility; health reads counters directly */ },
    __stats: () => ({ ...state, name }),
  };

  // Fire-and-forget probe so `checkRedisHealth` sees a real round trip.
  // Skipped in Workers: module scope forbids timers, and the first command
  // updates the same counters anyway.
  if (typeof (globalThis as any).WebSocketPair === 'undefined') {
    setTimeout(() => { client.ping().catch((e: any) => { state.errCount++; state.lastError = e?.message; }); }, 50);
  }
  return client;
}

/** True when the URL points at a provider with a REST proxy we can talk to. */
export function httpRedisSupported(url: string): boolean {
  const p = parseRedisUrl(url);
  return !!p && (/upstash\.io$/.test(p.host) || !!process.env.REDIS_REST_BASE);
}

// sha1-free fingerprint helper kept tiny: cache keys already carry their own
// prefixes; this exists only for debug logging parity with ioredis errors.
export function describeHttpRedis(url: string): string {
  const p = parseRedisUrl(url);
  if (!p) return 'redis-http(invalid-url)';
  return `redis-http(${createHash('sha1').update(p.host).digest('hex').slice(0, 8)})`;
}
