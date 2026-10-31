import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import { createHttpRedisClient } from '@/infrastructure/db/redis-http';

/* Minimal Upstash-REST stand-in: POST /GET/key → JSON reply,
   POST /pipeline → array of {result}. Records every path it saw. */

let server: any;
let port = 0;
const store = new Map<string, string>();
const hashStore = new Map<string, Record<string, string>>();
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((req: any, res: any) => {
    let body = '';
    req.on('data', (c: any) => (body += c));
    req.on('end', () => {
      seen.push(req.url!);
      res.setHeader('content-type', 'application/json');
      const parts = decodeURIComponent(req.url!).slice(1).split('/');
      const cmd = parts[0].toUpperCase();
      if (cmd === 'PIPELINE') {
        const tx = JSON.parse(body || '[]');
        const out = tx.map((c: string[]) => {
          const name = c[0].toUpperCase();
          if (name === 'INCR') { const v = Number(store.get(c[1]) || 0) + 1; store.set(c[1], String(v)); return { result: v }; }
          if (name === 'PTTL') return { result: store.has(c[1]) ? 42000 : -1 };
          if (name === 'PEXPIRE') return { result: 1 };
          if (name === 'HSET') { const h = hashStore.get(c[1]) || {}; for (let i = 2; i + 1 < c.length; i += 2) h[c[i]] = String(c[i + 1]); hashStore.set(c[1], h); return { result: 1 }; }
          if (name === 'GET') return { result: store.get(c[1]) ?? null };
          if (name === 'DEL') { const had = store.delete(c[1]) || hashStore.delete(c[1]); return { result: had ? 1 : 0 }; }
          return { result: 'OK' };
        });
        res.end(JSON.stringify(out));
      } else if (cmd === 'GET') {
        res.end(JSON.stringify(store.get(parts[1]) ?? null));
      } else if (cmd === 'SET') {
        store.set(parts[1], parts[2] || '');
        res.end(JSON.stringify('OK'));
      } else if (cmd === 'PTTL') {
        res.end(JSON.stringify(42000));
      } else if (cmd === 'HGETALL') {
        const h = hashStore.get(parts[1]) || {};
        const flat: string[] = [];
        for (const [f, v] of Object.entries(h)) flat.push(f, v);
        res.end(JSON.stringify(flat));
      } else if (cmd === 'PING') {
        res.end(JSON.stringify('PONG'));
      } else if (cmd === 'HMGET') {
        const h = hashStore.get(parts[1]) || {};
        res.end(JSON.stringify(parts.slice(2).map((f) => (h[f] ?? null))));
      } else if (cmd === 'HSET' || cmd === 'SETEX') {
        // Upstash REST takes every argument in the URL path: /HSET/key/f1/v1/…
        if (cmd === 'SETEX') { store.set(parts[1], parts[3] || ''); res.end(JSON.stringify('OK')); }
        else {
          const h = hashStore.get(parts[1]) || {};
          for (let i = 2; i + 1 < parts.length; i += 2) h[parts[i]] = parts[i + 1];
          hashStore.set(parts[1], h);
          res.end(JSON.stringify(1));
        }
      } else if (cmd === 'HGET') {
        res.end(JSON.stringify((hashStore.get(parts[1]) || {})[parts[2]] ?? null));
      } else if (cmd === 'HDEL') {
        const h = hashStore.get(parts[1]);
        let n = 0;
        for (const f of parts.slice(2)) if (h && delete h[f]) n++;
        res.end(JSON.stringify(n));
      } else if (cmd === 'DEL') {
        let n = 0;
        for (const k of parts.slice(1)) { if (store.delete(k)) n++; if (hashStore.delete(k)) n++; }
        res.end(JSON.stringify(n));
      } else {
        res.end(JSON.stringify('OK'));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(() => server?.close());

function makeClient() {
  return createHttpRedisClient('test', {
    url: `redis://user:pass@127.0.0.1:6379`,
    restBase: `http://127.0.0.1:${port}`,
  });
}

describe('redis-http client', () => {
  it('get/set round-trip over REST', async () => {
    const c = makeClient();
    await c.set('k1', 'v1');
    expect(store.get('k1')).toBe('v1'); // SET rides the URL path; stub stored it
    store.set('k1', 'hello');
    expect(await c.get('k1')).toBe('hello');
  });

  it('set with EX mode passes through', async () => {
    const c = makeClient();
    seen.length = 0;
    await c.set('k2', 'v2', 'EX', 60);
    expect(seen[0]).toContain('EX');
    expect(seen[0]).toContain('60');
  });

  it('multi/exec pipelines in one request', async () => {
    const c = makeClient();
    store.delete('cnt');
    await new Promise((r) => setTimeout(r, 80)); // let the startup ping land first
    seen.length = 0;
    const before = seen.length;
    const replies = await c.multi().incr('cnt').pexpire('cnt', 5000).exec();
    expect(seen.length - before).toBe(1); // exactly one HTTP round trip
    expect(replies[0][0]).toBeNull();
    expect(replies[0][1]).toBe(1); // INCR result
    expect(replies[1][1]).toBe(1); // PEXPIRE result
  });

  it('eval CONSUME emulation returns [count, pttl] and arms expiry', async () => {
    const c = makeClient();
    store.set('win', '2'); // count 3 after INCR, PTTL stub says live
    const [count, pttl] = await c.eval("local x = redis.call('INCR', KEYS[1]) redis.call('PEXPIRE', KEYS[1], ARGV[1]) return {x, redis.call('PTTL', KEYS[1])}", 1, 'win', '60000');
    expect(count).toBe(3);
    expect(pttl).toBe(42000);
  });

  it('eval CONsume arms PEXPIRE when window is fresh', async () => {
    const c = makeClient();
    store.delete('fresh');
    seen.length = 0;
    const [count] = await c.eval("local x = redis.call('INCR', KEYS[1]) redis.call('PEXPIRE', KEYS[1], ARGV[1]) return {x, redis.call('PTTL', KEYS[1])}", 1, 'fresh', '60000');
    expect(count).toBe(1);
    const pipelineBody = seen.find((s) => s.startsWith('/pipeline'));
    expect(pipelineBody).toBeDefined();
  });

  it('eval PEEK returns [count, pttl] without incrementing', async () => {
    const c = makeClient();
    store.set('peekme', '7');
    const [count, pttl] = await c.eval("return { tonumber(redis.call('GET', KEYS[1]) or '0'), redis.call('PTTL', KEYS[1]) }", 1, 'peekme');
    expect(count).toBe(7);
    expect(pttl).toBe(42000);
    expect(store.get('peekme')).toBe('7');
  });

  it('unsupported eval throws (consumers degrade)', async () => {
    const c = makeClient();
    await expect(c.eval('return 1', 0)).rejects.toThrow(/unsupported script/);
  });

  it('ping works and quit resolves', async () => {
    const c = makeClient();
    expect(await c.ping()).toBe('PONG');
    expect(await c.quit()).toBe('OK');
  });

  it('getdel returns the value once and removes the key', async () => {
    const c = makeClient();
    store.set('once', 'jane');
    expect(await c.getdel('once')).toBe('jane');
    expect(await c.getdel('once')).toBeNull();
  });

  it('hash commands round-trip (blocklist + device-accounts shape)', async () => {
    const c = makeClient();
    await c.hset('h1', 'f1', 'v1');
    expect(await c.hget('h1', 'f1')).toBe('v1');
    await c.hset('h2', { a: '1', b: '2' });
    expect(await c.hgetall('h2')).toEqual({ a: '1', b: '2' });
    await c.hdel('h2', 'a');
    expect(await c.hget('h2', 'a')).toBeNull();
  });

  it('multi supports hset+expire (device-accounts pipeline)', async () => {
    const c = makeClient();
    const replies = await c.multi().hset('dev:1', 'user9', '1730000000000').expire('dev:1', 600).exec();
    expect(replies[0][1]).toBe(1);
    expect(hashStore.get('dev:1')?.user9).toBe('1730000000000');
  });

  it('eval GETDEL emulation spends a magic jti exactly once', async () => {
    const c = makeClient();
    store.set('magic:j1', 'user-7');
    const script = "local x = redis.call('GET', KEYS[1]) if x then redis.call('DEL', KEYS[1]) end return x or ''";
    expect(await c.eval(script, 1, 'magic:j1')).toBe('user-7');
    expect(await c.eval(script, 1, 'magic:j1')).toBe('');
  });

  it('eval COOLDOWN emulation allows, cools down, then blocks on window', async () => {
    const c = makeClient();
    hashStore.delete('cd:k');
    store.delete('cd:k');
    // The real COOLDOWN_LUA reads HGET c/ws/ls and HSETs all three fields.
    const COOLDOWN = `
      local now = tonumber(ARGV[1]) local cdMs = tonumber(ARGV[2]) local winMs = tonumber(ARGV[3])
      local maxA = tonumber(ARGV[4]) local ttlMs = tonumber(ARGV[5])
      local c = tonumber(redis.call('HGET', KEYS[1], 'c') or '0')
      local ws = tonumber(redis.call('HGET', KEYS[1], 'ws') or '0')
      local ls = tonumber(redis.call('HGET', KEYS[1], 'ls') or '0')
      if ws > 0 and (now - ws) >= winMs then c = 0; ws = 0 end
      if ws > 0 and c >= maxA then return {0, winMs - (now - ws), 'window'} end
      if ls > 0 and (now - ls) < cdMs then return {0, cdMs - (now - ls), 'cooldown'} end
      local newC = c + 1 local newWs = ws if newWs == 0 then newWs = now end
      redis.call('HSET', KEYS[1], 'c', newC, 'ws', newWs, 'ls', now)
      redis.call('PEXPIRE', KEYS[1], ttlMs)
      return {1, 0, ''}`.replace(/\s+/g, ' ');
    let r = await c.eval(COOLDOWN, 1, 'cd:k', String(Date.now()), '30000', '3600000', '5', '7200000');
    expect(r[0]).toBe(1);
    r = await c.eval(COOLDOWN, 1, 'cd:k', String(Date.now()), '30000', '3600000', '5', '7200000');
    expect(r[0]).toBe(0);
    expect(r[2]).toBe('cooldown');
    // exhaust the window (max 5 sends/hour); the 6th, still inside the hour,
    // blocks on 'window' rather than the per-send cooldown
    let t = Date.now();
    for (let i = 2; i < 5; i++) {
      t += 31_000;
      r = await c.eval(COOLDOWN, 1, 'cd:k', String(t), '30000', '3600000', '5', '7200000');
      expect(r[0]).toBe(1);
    }
    r = await c.eval(COOLDOWN, 1, 'cd:k', String(t + 31_000), '30000', '3600000', '5', '7200000');
    expect(r[0]).toBe(1); // 5th send of the hour still allowed
    r = await c.eval(COOLDOWN, 1, 'cd:k', String(t + 62_000), '30000', '3600000', '5', '7200000');
    expect(r[2]).toBe('window');
  });
});
