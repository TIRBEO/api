import { lookup } from 'node:dns/promises';

const PRIVATE_RANGES = [
  { name: '10/8', test: (a: number, b: number, c: number, d: number) => a === 10 },
  { name: '172.16/12', test: (a: number, b: number) => a === 172 && b >= 16 && b <= 31 },
  { name: '192.168/16', test: (a: number, b: number) => a === 192 && b === 168 },
  { name: '127/8', test: (a: number) => a === 127 },
  { name: '169.254/16', test: (a: number, b: number) => a === 169 && b === 254 },
  { name: '0/8', test: (a: number) => a === 0 },
  { name: '100.64/10 (CGNAT)', test: (a: number, b: number) => a === 100 && b >= 64 && b <= 127 },
  { name: '224/4 multicast', test: (a: number) => a >= 224 },
];

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  return PRIVATE_RANGES.some((r) => r.test(parts[0], parts[1], parts[2], parts[3]));
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