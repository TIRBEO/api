import { prisma } from './db/prisma';

const SYSTEM_RESERVED = new Set([
  'admin', 'root', 'system', 'tirbeo', 'support', 'postmaster',
  'api', 'auth', 'login', 'signup', 'www', 'mail',
]);

let reservedCache: { set: Set<string>; ts: number } | null = null;
const CACHE_TTL = 60000;

export function invalidateReservedCache() {
  reservedCache = null;
}

export async function isReservedAddress(address: string): Promise<{ blocked: boolean; reason: string }> {
  if (SYSTEM_RESERVED.has(address)) {
    return { blocked: true, reason: 'System reserved name' };
  }

  if (reservedCache && Date.now() - reservedCache.ts < CACHE_TTL) {
    if (reservedCache.set.has(address)) return { blocked: true, reason: 'Reserved name' };
    return { blocked: false, reason: '' };
  }

  try {
    const rows = await prisma.reservedAddress.findMany({
      select: { address: true },
    });
    const set = new Set(rows.map(r => r.address));
    reservedCache = { set, ts: Date.now() };
    if (set.has(address)) return { blocked: true, reason: 'Reserved name' };
  } catch {
    // DB unavailable
  }

  return { blocked: false, reason: '' };
}
