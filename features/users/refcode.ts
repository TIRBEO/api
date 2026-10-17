// Per-user event IDs shown on blocked/banned/suspended screens and in
// security emails. Vercel/Stripe style: xxxx-xxxx-xxxx (12 hex chars, 3 blocks).
//
//   xxxx-xxxx-xxxx   →   a1b2-c3d4-e5f6
//
//   12 hex chars from crypto randomness (or deterministic fallback for legacy).
//   No type prefix — the kind is inferred from context (ban/suspend/ratelimit/system).
//
// Codes are PERSISTED in user_status_events.metadata.refCode (set when an
// admin bans/suspends, or — for legacy accounts without a stored code — by
// ensureRefCode() on first display) so staff can look a user up by event ID
// from the admin console. A code shown to a user must exist in the DB;
// eventIdFor() remains only as the DB-unreachable fallback.

export type EventKind = 'ban' | 'suspend' | 'ratelimit' | 'system';
// Codes may also be persisted for deleted accounts; helpers accept the widened kind.
type DisplayKind = EventKind | 'deleted';

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
export function generateEventId(_kind: DisplayKind): string {
  const part1 = randomHex(4);
  const part2 = randomHex(4);
  const part3 = randomHex(4);
  return `${part1}-${part2}-${part3}`;
}

/**
 * Deterministic fallback (legacy accounts without a stored code). Stable for
 * a given user+kind so repeated denials always surface the same reference.
 *
 * READ-ONLY LEGACY DISPLAY HELPER — never hand a code to a user on a block
 * screen through this function any more. A code a person sees must exist in
 * the database so they can quote it and staff can look it up; call
 * ensureRefCode() instead, which mints once and persists. This stays only as
 * the last-resort fallback inside ensureRefCode when the DB is unreachable.
 */
export function eventIdFor(userId: string, _kind: DisplayKind): string {
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

/**
 * The code a block screen shows for a banned/suspended account — guaranteed
 * to be PERSISTED. Reads the newest user_status_events row for the user's
 * current enforcement status; if it (or the whole row) carries no
 * metadata.refCode, mints a fresh crypto code, writes it back (updating the
 * existing event, or creating a dedicated enforcement status event when the
 * legacy row predates codes entirely), and returns that. Every code a user
 * ever sees is therefore findable in user_status_events — and, for
 * admin-banned accounts, mirrored into activity_events by the enforcement
 * write path (security.user_banned / security.user_suspended with
 * metadata.refCode).
 *
 * Falls back to the deterministic legacy code only when the DB itself is
 * unreachable — refusing to answer a blocked user with any reference at all
 * is worse than an un-persisted one during an outage.
 *
 * The prisma import is lazy so this module stays dependency-free for the
 * proxy bundle, which imports it statically.
 */
export async function ensureRefCode(userId: string, kind: EventKind | 'deleted'): Promise<string> {
  const toStatus = kind === 'ban' ? 'banned' : kind === 'suspend' ? 'suspended' : kind === 'deleted' ? 'deleted' : null;
  if (!toStatus) return generateEventId(kind);
  try {
    const { prisma } = await import('@/infrastructure/db/prisma');
    const latest = await prisma.userStatusEvent.findFirst({
      where: { userId, toStatus },
      orderBy: { createdAt: 'desc' },
      select: { id: true, metadata: true } });
    const stored = (latest?.metadata as Record<string, unknown> | null)?.refCode;
    if (typeof stored === 'string' && stored.trim()) return stored.trim();

    const code = generateEventId(kind);
    if (latest) {
      const meta = latest.metadata && typeof latest.metadata === 'object' && !Array.isArray(latest.metadata)
        ? (latest.metadata as Record<string, unknown>) : {};
      await prisma.userStatusEvent.update({
        where: { id: latest.id },
        data: { metadata: { ...meta, refCode: code } as never } });
    } else {
      // No enforcement status event exists at all (legacy ban predating the
      // status-history tables) — file a dedicated row so the code has a home.
      await prisma.userStatusEvent.create({
        data: {
          userId,
          fromStatus: toStatus as never,
          toStatus: toStatus as never,
          reason: 'Reference code backfilled when first shown to the user',
          actor: 'system',
          metadata: { refCode: code, backfilled: true } as never } });
    }
    // Mirror the freshly persisted code into activity_events too, so an admin
    // searching the event log by reference code finds backfilled codes exactly
    // like codes minted by a ban/suspend (security.user_banned rows).
    await prisma.activityEvent.create({
      data: {
        userId,
        kind: 'security.ref_code_assigned',
        title: 'Reference code assigned',
        detail: `Code ${code} persisted for ${toStatus} account (first display).`,
        severity: 'info',
        metadata: { refCode: code, status: toStatus } as never } }).catch(() => {});
    return code;
  } catch {
    return eventIdFor(userId, kind);
  }
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
