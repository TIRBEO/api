import { lookup } from 'node:dns/promises';

const PRIVATE_RANGES: { name: string; test: (o: number[]) => boolean }[] = [
  { name: '10/8', test: (o) => o[0] === 10 },
  { name: '172.16/12', test: (o) => o[0] === 172 && o[1] >= 16 && o[1] <= 31 },
  { name: '192.168/16', test: (o) => o[0] === 192 && o[1] === 168 },
  { name: '127/8', test: (o) => o[0] === 127 },
  { name: '169.254/16', test: (o) => o[0] === 169 && o[1] === 254 },
  { name: '0/8', test: (o) => o[0] === 0 },
  { name: '100.64/10 (CGNAT)', test: (o) => o[0] === 100 && o[1] >= 64 && o[1] <= 127 },
  { name: '224/4 multicast', test: (o) => o[0] >= 224 },
];

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  return PRIVATE_RANGES.some((r) => r.test(parts));
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('fc') || lower.startsWith('fd') ||  // fc00::/7 (ULA)
    lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') || // fe80::/10 link-local
    lower.startsWith('::ffff:') // mapped private v4 handled below as v4
  );
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.local') ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal')
  );
}

/**
 * SSRF guard for user-supplied URLs (push subscription endpoints, webhooks).
 * Requires https: (unless allowHttp), rejects credentials, resolves DNS and
 * blocks private / loopback / link-local / metadata / CGNAT / multicast
 * addresses.
 */
export async function isSafeExternalUrl(raw: string, opts?: { allowHttp?: boolean }): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol === 'https:') {
    // ok
  } else if (url.protocol === 'http:' && opts?.allowHttp) {
    // ok (dev-only webhook targets)
  } else {
    return false;
  }
  if (url.username || url.password) return false;
  // Push/webhook targets should never be off the standard port — non-standard
  // ports frequently proxy into internal services.
  if (url.port && url.port !== '443' && url.port !== '80') return false;

  const hostname = url.hostname.toLowerCase();
  if (isBlockedHostname(hostname)) return false;

  // IP literal host?
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
  if (isIp) {
    if (hostname.includes(':') && isPrivateV6(hostname)) return false;
    if (isPrivateV4(hostname)) return false;
  }

  // Resolve DNS and verify every address is public.
  try {
    const res = await lookup(hostname, { all: true, verbatim: true });
    for (const r of res) {
      if (r.address.includes(':')) {
        if (isPrivateV6(r.address)) return false;
        // Handle IPv4-mapped
        if (r.address.toLowerCase().startsWith('::ffff:')) {
          if (isPrivateV4(r.address.slice(7))) return false;
        }
        continue;
      }
      if (isPrivateV4(r.address)) return false;
    }
  } catch {
    return false; // unresolvable => block
  }

  return true;
}

/**
 * Delivery-time re-check.
 *
 * Validating a stored endpoint once, at subscribe time, leaves a window: DNS is
 * resolved again when the push is actually sent, so a host the subscriber owns
 * with a one-second TTL can answer "public" while the row was written and
 * "169.254.169.254" when the POST goes out. Re-checking the same predicate at
 * send time closes that window for everything but a sub-second race, at the
 * cost of one lookup per host per minute (cached, because a broadcast walks
 * every subscription of every user).
 */
const SEND_CHECK_TTL_MS = 60_000;
const sendChecks = new Map<string, { ok: boolean; until: number }>();

export async function isSafePushEndpointAtSendTime(endpoint: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(endpoint).host.toLowerCase();
  } catch {
    return false;
  }
  const now = Date.now();
  const cached = sendChecks.get(host);
  if (cached && cached.until > now) return cached.ok;
  const ok = await isSafeExternalUrl(endpoint);
  sendChecks.set(host, { ok, until: now + SEND_CHECK_TTL_MS });
  if (sendChecks.size > 500) {
    for (const [key, value] of sendChecks) if (value.until <= now) sendChecks.delete(key);
  }
  return ok;
}