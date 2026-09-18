// Per-user event IDs shown on blocked/banned/suspended screens and in
// security emails. Vercel/Stripe style: xxxx-xxxx-xxxx (12 hex chars, 3 blocks).
//
//   xxxx-xxxx-xxxx   →   a1b2-c3d4-e5f6
//
//   12 hex chars from crypto randomness (or deterministic fallback for legacy).
//   No type prefix — the kind is inferred from context (ban/suspend/ratelimit/system).
//
// Codes are PERSISTED on the user profile (banRefCode / suspendRefCode, set
// when an admin bans/suspends) so staff can look a user up by event ID from
// the admin console. The deterministic fallback guarantees a usable code for
// legacy accounts without stored codes.

export type EventKind = 'ban' | 'suspend' | 'ratelimit' | 'system';

const HEX = '0123456789abcdef';

function fnv1a(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function randomHex(len: number): string {
  try {
    const bytes = new Uint8Array(Math.ceil(len / 2));
    (globalThis.crypto || (globalThis as any)?.crypto)?.getRandomValues?.(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, len);
  } catch { /* fall through to LCG */ }
  let r = Math.random();
  let out = '';
  for (let i = 0; i < len; i++) {
    r = (r * 1664525 + 1013904223) % 4294967296;
    out += HEX[Math.floor((r / 4294967296) * 16)];
  }
  return out;
}

// ─── New event IDs (crypto-backed) ───
// Format: xxxx-xxxx-xxxx (12 hex chars, no type prefix)
export function generateEventId(_kind: EventKind): string {
  const part1 = randomHex(4);
  const part2 = randomHex(4);
  const part3 = randomHex(4);
  return `${part1}-${part2}-${part3}`;
}

// Deterministic fallback (legacy accounts without a stored code). Stable for
// a given user+kind so repeated denials always surface the same reference.
export function eventIdFor(userId: string, _kind: EventKind): string {
  const h1 = fnv1a(`event:v2:${userId}`) & 0xffff;
  const h2 = fnv1a(`event:v2:${userId}:salt`, 0x9e3779b9) & 0xffff;
  const h3 = fnv1a(`event:v2:${userId}:salt2`, 0xdeadbeef) & 0xffff;
  return `${h1.toString(16).padStart(4, '0')}-${h2.toString(16).padStart(4, '0')}-${h3.toString(16).padStart(4, '0')}`;
}

// Best stored-or-generated code for a user row (current status kind).
export function eventIdForUser(
  userId: string,
  kind: EventKind,
  stored?: string | null
): string {
  if (stored && stored.trim()) return stored.trim();
  return eventIdFor(userId, kind);
}

// Canonical display form from a 12-char hex token.
export function formatEventId(_kind: EventKind, token: string): string {
  const digits = (token || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (digits.length >= 12) {
    const d = digits.slice(0, 12);
    return `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8, 12)}`;
  }
  if (digits.length === 8) {
    // Legacy 8-char format — pad to 12 with deterministic hash
    const extra = fnv1a(digits, 0x12345678) & 0xffff;
    return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${extra.toString(16).padStart(4, '0')}`;
  }
  return digits;
}

export interface ParsedEventId {
  kind: EventKind | null;   // cannot be determined from format alone
  digits: string;           // full hex payload, lowercased (up to 12 chars)
  token: string;            // full 12-char formatted token
}

// Normalize whatever the user typed into a parsed event ID.
// Accepts: a1b2-c3d4-e5f6, a1b2c3d4e5f6, a1b2_c3d4_e5f6, and legacy forms.
// The input must be ENTIRELY hex (after stripping separators/prefixes).
export function parseEventId(input: string): ParsedEventId | null {
  const raw = (input || '').trim();
  if (!raw) return null;

  // Strip legacy prefixes (SUS-, BAN-, AU-, RL-, SY-)
  const stripped = raw.replace(/^(SUS|BAN|AU|RL|SY)[\s_-]*/i, '');
  const compact = stripped.replace(/[\s_-]+/g, '').toLowerCase();
  if (!/^[0-9a-f]{4,16}$/.test(compact)) return null;
  const digits = compact;

  // Determine token: prefer full 12-char, else pad 8-char to 12
  let token: string;
  if (digits.length >= 12) {
    token = formatEventId('suspend', digits.slice(0, 12)); // kind doesn't matter for formatting
  } else if (digits.length >= 8) {
    token = formatEventId('suspend', digits);
  } else {
    token = digits.padStart(12, '0');
  }

  return {
    kind: null, // cannot determine from format alone
    digits,
    token,
  };
}

// Every stored shape the admin resolver should match for a typed-in code.
// Covers canonical xxxx-xxxx-xxxx, plain 12-char, 8-char legacy, and SUS-/BAN- prefixes.
export function refCodeCandidates(input: string): string[] {
  const parsed = parseEventId(input);
  if (!parsed) return [];

  const out = new Set<string>();
  const { token } = parsed;

  // Canonical form
  out.add(token);
  // Raw 12-char
  if (parsed.digits.length >= 12) out.add(parsed.digits.slice(0, 12));
  // 8-char legacy
  if (parsed.digits.length >= 8) out.add(parsed.digits.slice(-8));

  // Legacy prefixed storage from the brief SUS-/BAN- era.
  out.add(`SUS-${token.slice(-8)}`);
  out.add(`BAN-${token.slice(-8)}`);

  return Array.from(out);
}
