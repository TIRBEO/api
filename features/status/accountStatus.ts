import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession, requireAdmin } from '@/features/auth/http-guards';
import { jsonUnauthorized } from '@/shared/response';

/* ═══════════════════════════════════════════════════════════════════
   Account status level — the number an admin decides, the person reads.

   Every account carries a whole number starting at 0. Zero is not "no
   status" — it is the status, and it means *nothing has been decided
   about this account*. Only an admin raises it (the admin panel writes
   through `adminAccountStatusHandler`); the settings screen reads it and
   can never change it. A brand-new account has no row yet, so the first
   read materialises the 0 into the store — the value exists from the
   moment the account can be asked about it, not from the moment anyone
   flags something.

   It lives in `preferences.user_preferences.misc.accountStatus`, kept
   OUTSIDE `misc.settings` on purpose: the settings bag is writable by
   anyone who can PATCH /api/settings, and a value the person can edit
   is not a value an admin decided. One pair of functions — load here,
   set here — is the only reader and writer.
   ═══════════════════════════════════════════════════════════════════ */

export type AccountStatus = {
  level: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** The answer for every account nobody has decided anything about. */
export const DEFAULT_STATUS_LEVEL = 0;

const asObj = (raw: unknown): Record<string, any> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {};

/** Only a whole number ≥ 0 is a decision; anything else reads as 0 rather
    than as an error, so a hand-edited blob can never 500 the settings page
    or strand an account with no answer. */
function readLevel(misc: Record<string, any>): number {
  const stored = asObj(misc.accountStatus);
  const level = stored.level;
  return typeof level === 'number' && Number.isInteger(level) && level >= 0 ? level : DEFAULT_STATUS_LEVEL;
}

export function isValidStatusLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Merge-write the level into `misc.accountStatus`, preserving every other
    key in misc (the settings bag lives alongside it). */
async function writeLevel(userId: string, level: number, updatedBy: string): Promise<void> {
  const row = await prisma.userPreferences.findUnique({
    where: { userId },
    select: { misc: true },
  });
  const misc = asObj(row?.misc);
  const accountStatus = {
    ...asObj(misc.accountStatus),
    level,
    updatedBy,
    updatedAt: new Date().toISOString(),
  };
  await prisma.userPreferences.upsert({
    where: { userId },
    create: { userId, misc: { ...misc, accountStatus } as any },
    update: { misc: { ...misc, accountStatus } as any },
  });
}

/** The one read: always answers, always with a number. Missing row, missing
    key, junk value — all of them say 0. The first read of an account that
    has no stored value writes the 0, so the store itself holds the default
    for every account that has ever been asked. */
export async function loadAccountStatus(userId: string): Promise<AccountStatus> {
  const row = await prisma.userPreferences.findUnique({
    where: { userId },
    select: { misc: true },
  });
  const misc = asObj(row?.misc);
  if (!misc.accountStatus) {
    await writeLevel(userId, DEFAULT_STATUS_LEVEL, 'system');
    return { level: DEFAULT_STATUS_LEVEL, updatedAt: null, updatedBy: 'system' };
  }
  const stored = asObj(misc.accountStatus);
  return {
    level: readLevel(misc),
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
  };
}

/** The one write, for the admin panel. Validation of `level` happens at the
    handler edge; a non-decision never reaches the store. */
export async function setAccountStatusLevel(
  userId: string,
  level: number,
  updatedBy: string,
): Promise<AccountStatus> {
  await writeLevel(userId, level, updatedBy);
  return loadAccountStatus(userId);
}

// ─── HTTP edges ────────────────────────────────────────────────────

/** GET /api/user/account-status — the person's own number, read-only.
    Never 404s for "no status": an account with nothing decided answers 0. */
export async function accountStatusHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    // An admin may ask about any account (?userId=) so the panel can read
    // the same number it writes; everyone else only ever reads their own.
    let targetUserId = session.userId;
    const asked = new URL(request.url).searchParams.get('userId');
    if (asked && asked !== session.userId) {
      const admin = await requireAdmin(request);
      if (admin instanceof NextResponse) return admin;
      targetUserId = asked;
    }

    const status = await loadAccountStatus(targetUserId);
    return NextResponse.json({ ok: true, ...status });
  } catch (err: any) {
    console.error('[ACCOUNT_STATUS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to read account status' }, { status: 500 });
  }
}

/** PUT /api/admin/account-status { userId, level } — admin-only raise (or
    return to 0). The person's own screen has no path to this value. */
export async function adminAccountStatusHandler(request: NextRequest) {
  try {
    const admin = await requireAdmin(request);
    if (admin instanceof NextResponse) return admin;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const userId = typeof body.userId === 'string' ? body.userId : '';
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    if (!isValidStatusLevel(body.level)) {
      return NextResponse.json({ error: 'level must be a whole number of 0 or above' }, { status: 400 });
    }

    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const status = await setAccountStatusLevel(userId, body.level, `admin:${admin.userId}`);
    return NextResponse.json({ ok: true, ...status });
  } catch (err: any) {
    console.error('[ADMIN/ACCOUNT_STATUS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to update account status' }, { status: 500 });
  }
}
