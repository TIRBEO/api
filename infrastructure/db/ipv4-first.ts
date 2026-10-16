import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';

/**
 * The Supabase pooler answers with AAAA records some of the time, and a machine
 * with no IPv6 route fails that connect with ENETUNREACH outright — there is no
 * fallback when the answer holds no A record at all. Node's Happy Eyeballs (on
 * by default since v20) ignores `--dns-result-order=ipv4first`, so the only
 * switch that reaches pg's own lookups is this pair: turn it off, ask for IPv4
 * first. Idempotent, and a no-op where IPv6 actually works.
 */
try {
  setDefaultAutoSelectFamily(false);
  setDefaultResultOrder('ipv4first');
} catch {
  /* runtimes without these setters keep their defaults */
}
