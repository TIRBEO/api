// Per-user event IDs shown on blocked/banned/suspended screens and in
// security emails. Vercel/Stripe style, widened to 64 bits of crypto
// randomness so quoting one is unambiguous and guessing one is not a
// project:
//
//   xxxx-xxxx-xxxx-xxxx   →   a1b2-c3d4-e5f6-7a8b   (new, 16 hex)
//   xxxx-xxxx-xxxx        →   a1b2-c3d4-e5f6        (legacy, 12 hex)
//
//   No type prefix — the kind is inferred from context (ban/suspend/ratelimit/system).
//
// Codes are PERSISTED in user_status_events.metadata.refCode (set when an
// admin bans/suspends, or — for legacy accounts without a stored code — by
// ensureRefCode() on first display) so staff can look a user up by event ID
// from the admin console. A code shown to a user must exist in the DB;
// eventIdFor() remains only as the DB-unreachable fallback.

export type EventKind = 'ban' | 'suspend' | 'ratelimit' | 'system';
// Codes may also be persisted for deleted accounts; helpers accept the widened kind.
// 'delete' (a scheduled deletion the person can still cancel) and 'deactivate'
// (a self-serve pause) join it so every blocked-lifecycle screen can quote one.
export type DisplayKind = EventKind | 'deleted' | 'delete' | 'deactivate';

function fnv1a(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Crypto hex — the ONLY source of new codes. There is deliberately no
    Math.random fallback: a "reference code" that a deterministic LCG could
    generate is a code an attacker could generate, and every runtime this
    module runs on (Node ≥ 19 route handlers, Edge middleware, browsers) has
    Web Crypto. If it ever doesn't, failing loudly is correct — silently
    downgrading to guessable ids is what we retired.
    The generators live in infrastructure/ids/event-id so the DB write choke
    point can stamp refs without importing features/. */
import { randomHex, group16, group12, generateEventId } from '@/infrastructure/ids/event-id';

export { generateEventId } from '@/infrastructure/ids/event-id';

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

/**
 * Short reference for any row whose id is (or contains) a uuid — login-ledger
 * rows have no metadata column, so their code is derived from the row id
 * itself: first 16 hex digits, grouped. Stable, unique per row, and nothing
 * has to be backfilled. (Rows displayed before the widening quoted the first
 * 12; refCodeCandidates() still resolves those through the admin search.)
 */
export function refFromRowId(id: string): string | null {
  const hex = (id || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length >= 16) return group16(hex.slice(0, 16));
  if (hex.length >= 12) return group12(hex.slice(0, 12));
  return null;
}

/** The reference to show for one activity row: its stamped metadata.refCode
    when it has one (every row written since ref-stamping, and every backfill
    through ensureRefCode), else the deterministic code derived from its id. */
export function eventRowRef(row: { id: string; metadata?: unknown }): string {
  const meta = row.metadata;
  const stored = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).refCode : null;
  if (typeof stored === 'string' && stored.trim()) return stored.trim();
  return refFromRowId(row.id) ?? row.id;
}

/** Collapse a raw error into a stable identity: ids, hashes and digits vary
    per occurrence but the fault does not, so `load failed after 1234ms [uuid]`
    and `load failed after 99ms [other-uuid]` must share one signature. */
function faultSignature(raw: string): string {
  return raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\b[0-9a-f]{16,}\b/gi, ':hex')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Event ID for a server-side fault (the 500 path). Unlike generateEventId,
 * the code is DETERMINISTIC per error signature and PERSISTED: the first
 * occurrence of a fault writes an activity_events row with metadata.refCode,
 * and every occurrence of the same fault within 24h re-reads that row and
 * shows the same ID. Repeats beyond the window open a new incident, so staff
 * can tell "same ongoing failure" from "it came back". The code is always
 * findable in admin — search by event id resolves metadata.refCode.
 *
 * If the DB is unreachable the fault can't be recorded; we still return a
 * stable shape (deterministic group + random tail) rather than nothing.
 */
export async function systemFaultRef(rawSignature: string): Promise<string> {
  const sig = faultSignature(rawSignature);
  const g1 = (fnv1a(`fault:${sig}`) & 0xffff).toString(16).padStart(4, '0');
  const g2 = (fnv1a(`fault:${sig}`, 0x9e3779b9) & 0xffff).toString(16).padStart(4, '0');
  const group = `${g1}-${g2}`;
  try {
    const { prisma } = await import('@/infrastructure/db/prisma');
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await prisma.activityEvent.findFirst({
      where: {
        kind: 'system.error',
        createdAt: { gte: since },
        metadata: { path: ['signature'], equals: sig } },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true } });
    const stored = (recent?.metadata as Record<string, unknown> | null)?.refCode;
    if (typeof stored === 'string' && stored.trim()) return stored.trim();
    // The two deterministic groups carry the fault's identity (same ongoing
    // failure → same prefix); eight fresh random hex per incident make the
    // full code a standard xxxx-xxxx-xxxx-xxxx with 32 unpredictable bits.
    const code = group16(`${group.replace(/-/g, '')}${randomHex(8)}`);
    await prisma.activityEvent.create({
      data: {
        kind: 'system.error',
        title: `System fault ${code}`,
        detail: rawSignature.slice(0, 500),
        severity: 'error',
        metadata: { refCode: code, signature: sig, group } as never } });
    return code;
  } catch {
    return group16(`${group.replace(/-/g, '')}${randomHex(8)}`);
  }
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
export async function ensureRefCode(userId: string, kind: DisplayKind): Promise<string> {
  const toStatus = kind === 'ban' ? 'banned' : kind === 'suspend' ? 'suspended' : kind === 'deleted' ? 'deleted'
    : kind === 'delete' ? 'deletion_pending' : kind === 'deactivate' ? 'deactivated' : null;
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

// Canonical display form from a hex token: 16 digits → four groups (the
// current shape), 12 → three (codes stored before the widening), 8 → the
// legacy form padded deterministically so old quotes still resolve.
export function formatEventId(_kind: EventKind, token: string): string {
  const digits = (token || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (digits.length >= 16) return group16(digits.slice(0, 16));
  if (digits.length >= 12) return group12(digits.slice(0, 12));
  if (digits.length === 8) {
    // Legacy 8-char format — pad to 12 with deterministic hash
    const extra = fnv1a(digits, 0x12345678) & 0xffff;
    return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${extra.toString(16).padStart(4, '0')}`;
  }
  return digits;
}

export interface ParsedEventId {
  kind: EventKind | null;   // cannot be determined from format alone
  digits: string;           // full hex payload, lowercased (up to 16 chars)
  token: string;            // full grouped token (16-hex or legacy 12-hex)
}

// Normalize whatever the user typed into a parsed event ID.
// Accepts: a1b2-c3d4-e5f6-7a8b, a1b2c3d4e5f67a8b, the legacy 3-group/12-char
// forms, 8-char legacy, and SUS-/BAN- prefixes.
// The input must be ENTIRELY hex (after stripping separators/prefixes).
export function parseEventId(input: string): ParsedEventId | null {
  const raw = (input || '').trim();
  if (!raw) return null;

  // Strip legacy prefixes (SUS-, BAN-, AU-, RL-, SY-)
  const stripped = raw.replace(/^(SUS|BAN|AU|RL|SY)[\s_-]*/i, '');
  const compact = stripped.replace(/[\s_-]+/g, '').toLowerCase();
  if (!/^[0-9a-f]{4,16}$/.test(compact)) return null;
  const digits = compact;

  // Determine token: the widest shape the typed digits actually fill.
  let token: string;
  if (digits.length >= 16) {
    token = group16(digits.slice(0, 16));
  } else if (digits.length >= 12) {
    token = group12(digits.slice(0, 12));
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
// A 16-hex code typed in full also quotes its own first 12 digits — the
// derived/legacy shape rows picked up before the widening — so one paste
// finds the row whichever era stamped it. Covers canonical grouped forms,
// plain hex, 8-char legacy, and SUS-/BAN- prefixes.
export function refCodeCandidates(input: string): string[] {
  const parsed = parseEventId(input);
  if (!parsed) return [];

  const out = new Set<string>();
  const { token, digits } = parsed;

  // Canonical form as typed (16-hex grouped, or legacy 12).
  out.add(token);
  // Raw (undashed) storage.
  if (digits.length >= 16) out.add(digits.slice(0, 16));
  if (digits.length >= 12) out.add(digits.slice(0, 12));
  // A 16-hex quote whose first 12 digits are the legacy derived code.
  if (digits.length >= 16) out.add(group12(digits.slice(0, 12)));
  // 8-char legacy.
  if (digits.length >= 8) out.add(digits.slice(-8));

  // Legacy prefixed storage from the brief SUS-/BAN- era.
  out.add(`SUS-${token.slice(-8)}`);
  out.add(`BAN-${token.slice(-8)}`);

  return Array.from(out);
}
