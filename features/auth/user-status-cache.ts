import { prisma } from '@/infrastructure/db/prisma';

/* ═══════════════════════════════════════════════════════════════════
   The account's lifecycle status, read once per minute

   Every door asks "is this account closed?" before it does anything else, so
   the answer is held for a minute instead of hitting the database per request.
   That cache is a copy of a row somebody can change — cancel a deletion,
   reactivate, an admin restriction — so the write owns the second half of this
   module: `forgetUserStatus`. A lifecycle write that forgets to call it leaves
   the account refusing requests for up to a minute after it stopped being
   closed, which reads exactly like the cancellation did nothing.

   This is its own module because the status is written from the lifecycle
   layer, the admin console and the gate alike, and none of them should have to
   import the others to say "the answer changed".
   ═══════════════════════════════════════════════════════════════════ */

const STATUS_TTL = 60_000;
const statusCache = new Map<string, { status: string | null; ts: number }>();

export async function cachedUserStatus(userId: string): Promise<string | null> {
  const hit = statusCache.get(userId);
  if (hit && Date.now() - hit.ts < STATUS_TTL) return hit.status;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    const status = user?.status ?? null;
    statusCache.set(userId, { status, ts: Date.now() });
    if (statusCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of statusCache) { if (now - v.ts >= STATUS_TTL) statusCache.delete(k); }
    }
    return status;
  } catch {
    // A lookup that did not answer must not close an open account — nor, once
    // it is known the account IS closed, must it open a closed one.
    return hit?.status ?? null;
  }
}

/** Drop this account's cached status. Every write that changes `User.status`
    owes this call. */
export function forgetUserStatus(userId: string): void {
  statusCache.delete(userId);
}
