// Crypto-backed reference codes, shared by the features layer and the DB
// write choke point (infrastructure/db/prisma.ts). This is the lowest layer
// the stamping lives at so infrastructure never imports features/.

export function randomHex(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

export const group16 = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8, 12)}-${d.slice(12, 16)}`;
export const group12 = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8, 12)}`;

// Format: xxxx-xxxx-xxxx-xxxx (16 hex chars, no type prefix).
// Birthday collisions across a million codes: ~1 in 37 million — the "no
// collision rate" a support lookup needs without a uniqueness query.
export function generateEventId(_kind?: string): string {
  return group16(randomHex(16));
}
