import { prisma } from '@/infrastructure/db/prisma';

/**
 * Coordinates the auth paths already recorded, for the ledgers that never
 * stored any.
 *
 * The sign-in list (`security.user_logins`) and the session list
 * (`security.user_sessions`) keep a place name but no point on the map —
 * they predate the map. Every sign-in, though, also wrote an `auth.login_*`
 * row into `activity.activity_events`, and those rows carry the latitude and
 * longitude the edge resolved the address to. Matching one ledger's row to
 * the other's is exact rather than guessed: the same account, the same
 * client address, the same minute. A row that finds no match gets `null` and
 * the page shows no pin — the honest answer for a place the record doesn't
 * have numbers for.
 */

/** Kinds every sign-in attempt writes, success or blocked. */
const LOGIN_EVENT_KINDS = [
  'auth.login_success',
  'auth.login_2fa_success',
  'auth.login_otp_success',
  'auth.login_recovery_2fa_success',
  'auth.login_recovery_email_success',
  'auth.login_failed',
  'auth.admin_login_success',
];

/** Two real numbers or nothing — a pin at (0,0) would put the map in the sea. */
export function coordsFromMeta(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [lat, lng] = value;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lat, lng];
}

/** IPv6-mapped IPv4 (`::ffff:127.0.0.1`) and the bare address are one address. */
function sameAddress(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const strip = (ip: string) => ip.replace(/^::ffff:/i, '').trim().toLowerCase();
  return strip(a) === strip(b);
}

/** A row of some ledger that wants to know where it happened. */
export type CoordsWanted = { ip: string | null; at: Date };

/**
 * One coords array per asked-for row, in the same order. Each row pairs with
 * the nearest login event on the same address within two minutes — the two
 * rows are seconds apart in practice, and the window only forgives clock
 * skew, it never reaches across a different sign-in.
 */
export async function coordsByLoginAttempt(
  userId: string,
  rows: CoordsWanted[],
): Promise<([number, number] | null)[]> {
  if (!rows.length) return [];
  const times = rows.map((r) => r.at.getTime());
  const pad = 2 * 60_000;
  const events = await prisma.activityEvent.findMany({
    where: {
      userId,
      kind: { in: LOGIN_EVENT_KINDS },
      createdAt: { gte: new Date(Math.min(...times) - pad), lte: new Date(Math.max(...times) + pad) },
    },
    select: { ipAddress: true, createdAt: true, metadata: true },
  });
  const pinned = events
    .map((e) => ({ ip: e.ipAddress, at: e.createdAt.getTime(), coords: coordsFromMeta((e.metadata as any)?.coords) }))
    .filter((e): e is { ip: string | null; at: number; coords: [number, number] } => e.coords !== null);

  return rows.map((row) => {
    let best: { at: number; coords: [number, number] } | null = null;
    for (const e of pinned) {
      if (!sameAddress(e.ip, row.ip)) continue;
      const delta = Math.abs(e.at - row.at.getTime());
      if (delta > pad) continue;
      if (!best || delta < Math.abs(best.at - row.at.getTime())) best = { at: e.at, coords: e.coords };
    }
    return best?.coords ?? null;
  });
}
