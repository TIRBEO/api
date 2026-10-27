import { prisma } from '@/infrastructure/db/prisma';

/* Platform-wide device, session, push, passkey and sign-in reads.
 *
 *  These five tables are the only place the console has ever looked at a
 *  *person's hardware* rather than at their decisions: what they signed in on,
 *  where from, what is still live. Each read is the same shape on purpose —
 *  page, limit, one filter, `{ rows, total, page, limit }` — so the six screens
 *  that consume them share one table component instead of six dialects.
 *
 *  What these selects deliberately leave out is the point of the file:
 *    - `user_sessions.token_hash` — the bearer half of a live session. The row
 *      can be identified by its own id, which is what revoke takes.
 *    - `push_subscriptions.endpoint` in full — a push endpoint URL is a bearer
 *      token: anybody holding it can wake that device. The provider host is all
 *      that is safe to render, and it answers the only question an operator asks
 *      of the column ("is this Firebase or a browser push service?").
 *    - `push_subscriptions.p256dh` / `.auth`, `passkeys.credential_pubkey` —
 *      key material. Presence is reported; the bytes are not.
 *  A select list is used everywhere rather than `include: true`, because the
 *  default for a table that holds secrets must be "nothing until named". */

/** The account columns a console row may name. Same three as every other admin
 *  list, so the same person's rows read identically on two screens. */
const ACTOR = {
  select: {
    email: true,
    username: true,
    profile: { select: { name: true } },
  },
} as const;

export type DeviceFilter = {
  page?: number;
  limit?: number;
  /** Address, username, name, device label, place or IP fragment. */
  q?: string;
  userId?: string;
  /** active | revoked */
  status?: string;
};

export type SessionFilter = DeviceFilter & {
  /** Only the ones that would still let someone in. */
  liveOnly?: boolean;
};

export type SignInFilter = {
  page?: number;
  limit?: number;
  q?: string;
  userId?: string;
  method?: string;
  /** 'true' | 'false' — an operator filters on failures with this. */
  success?: string;
  from?: string;
  to?: string;
};

const MAX_LIMIT = 200;

function pageArgs(filter: { page?: number; limit?: number }) {
  const page = Math.max(1, Number(filter.page) || 1);
  const limit = Math.min(MAX_LIMIT, Number(filter.limit) || 50);
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

/** The free-text box, applied to the columns that name a person or a place.
 *  `contains` rather than `startsWith` because an operator pastes the middle of
 *  an address they remember, not the beginning of one they typed. */
function textFilter(q: string, columns: string[]) {
  return {
    OR: columns.map((column) => ({ [column]: { contains: q, mode: 'insensitive' } })),
  };
}

function userMatch(q: string) {
  return {
    user: {
      OR: [
        { email: { contains: q, mode: 'insensitive' } },
        { username: { contains: q, mode: 'insensitive' } },
        { profile: { name: { contains: q, mode: 'insensitive' } } },
      ],
    },
  };
}

/** One search box across "who" and "where": the account clauses and the row's
 *  own columns cannot live in a single OR without the account terms escaping
 *  their scope, so they are two top-level ANDed alternatives. */
function whereFor(
  filter: { q?: string; userId?: string; status?: string },
  ownColumns: string[],
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (filter.userId) where.userId = filter.userId;
  if (filter.status) where.status = filter.status;
  const q = filter.q?.trim();
  if (q) where.AND = [{ OR: [userMatch(q), textFilter(q, ownColumns)] }];
  return where;
}

export async function listDevices(filter: DeviceFilter = {}) {
  const { page, limit, skip, take } = pageArgs(filter);
  const where = whereFor(filter, ['deviceName', 'userAgent', 'ipAddress', 'location']);
  const [rows, total] = await Promise.all([
    prisma.userDevice.findMany({
      where: where as any,
      orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
      select: {
        id: true,
        userId: true,
        deviceName: true,
        userAgent: true,
        ipAddress: true,
        location: true,
        status: true,
        createdAt: true,
        lastUsedAt: true,
        user: ACTOR,
      },
    }),
    prisma.userDevice.count({ where: where as any }),
  ]);
  return { rows, total, page, limit };
}

/** Sessions, newest activity first.
 *
 *  `live` is computed here rather than trusted from `status`, because the two
 *  ways a session stops disagreeing is exactly what an operator needs to see:
 *  a row still marked active that expired, and a row revoked before its expiry.
 *  `expiresAt` is in the select for that reason — the screen says which of the
 *  two ended a session, and cannot do that from status alone. */
export async function listSessions(filter: SessionFilter = {}) {
  const { page, limit, skip, take } = pageArgs(filter);
  const now = new Date();
  const where = whereFor(filter, ['deviceName', 'userAgent', 'ipAddress', 'location']);
  if (filter.liveOnly) {
    where.status = 'active';
    where.revokedAt = null;
    where.expiresAt = { gt: now };
  } else if (filter.liveOnly === false) {
    // Asked for explicitly, the same three conditions inverted; an operator who
    // wants the dead ones is asking a real question.
    where.OR = [
      { status: { not: 'active' } },
      { revokedAt: { not: null } },
      { expiresAt: { lte: now } },
    ];
  }
  const [rows, total] = await Promise.all([
    prisma.userSession.findMany({
      where: where as any,
      orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
      select: {
        id: true,
        userId: true,
        deviceName: true,
        userAgent: true,
        ipAddress: true,
        location: true,
        status: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        user: ACTOR,
      },
    }),
    prisma.userSession.count({ where: where as any }),
  ]);
  return {
    rows: rows.map((row) => ({
      ...row,
      live: row.status === 'active' && !row.revokedAt && row.expiresAt > now,
      endedBy: row.revokedAt ? 'revoked' : row.expiresAt <= now ? 'expired' : null,
    })),
    total,
    page,
    limit,
  };
}

/** Push subscriptions, with the provider host carved off the endpoint.
 *
 *  The host is a public DNS name of the push service and identifies nothing
 *  about the device; the path after it is the credential, so it never leaves
 *  this file. A value that is not a parseable URL — a row written by an older
 *  client — yields null rather than a guess, and the screen shows "unknown". */
export async function listPush(filter: DeviceFilter = {}) {
  const { page, limit, skip, take } = pageArgs(filter);
  const where = whereFor(filter, ['userAgent']);
  const [rows, total] = await Promise.all([
    prisma.pushSubscription.findMany({
      where: where as any,
      orderBy: { lastUsedAt: 'desc' },
      skip,
      take,
      select: {
        id: true,
        userId: true,
        endpoint: true,
        userAgent: true,
        createdAt: true,
        lastUsedAt: true,
        user: ACTOR,
      },
    }),
    prisma.pushSubscription.count({ where: where as any }),
  ]);
  return {
    rows: rows.map(({ endpoint, ...row }) => ({
      ...row,
      provider: providerOf(endpoint),
      /** Presence only. The keys that would let this box be written to are
          read by the sender, never by a screen. */
      hasKeys: true,
    })),
    total,
    page,
    limit,
  };
}

function providerOf(endpoint: string): string | null {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

export async function listPasskeys(filter: DeviceFilter = {}) {
  const { page, limit, skip, take } = pageArgs(filter);
  const q = filter.q?.trim();
  const where: Record<string, unknown> = {};
  if (filter.userId) where.userId = filter.userId;
  if (q) where.AND = [{ OR: [userMatch(q), textFilter(q, ['deviceName'])] }];
  const [rows, total] = await Promise.all([
    prisma.passkey.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true,
        userId: true,
        deviceName: true,
        transports: true,
        counter: true,
        createdAt: true,
        lastUsedAt: true,
        user: ACTOR,
      },
    }),
    prisma.passkey.count({ where: where as any }),
  ]);
  /* `counter` is the attestation-counter, not a secret, and it is the only
     read on whether a key has actually been used to sign anything. BigInt does
     not survive JSON, so it leaves as a decimal string and the screen says how
     many signatures this key has made. */
  return {
    rows: rows.map((row) => ({ ...row, counter: row.counter.toString() })),
    total,
    page,
    limit,
  };
}

export async function listSignIns(filter: SignInFilter = {}) {
  const { page, limit, skip, take } = pageArgs(filter);
  const where: Record<string, unknown> = {};
  if (filter.userId) where.userId = filter.userId;
  if (filter.method) where.method = filter.method;
  if (filter.success === 'true' || filter.success === 'false') {
    where.success = filter.success === 'true';
  }
  const range: Record<string, unknown> = {};
  if (filter.from) range.gte = new Date(filter.from);
  if (filter.to) range.lte = new Date(filter.to);
  if (Object.keys(range).length) where.createdAt = range;
  const q = filter.q?.trim();
  if (q) where.AND = [{ OR: [userMatch(q), textFilter(q, ['ipAddress', 'location', 'userAgent', 'method'])] }];

  const [rows, total, failures, byMethod] = await Promise.all([
    prisma.userLogin.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true,
        userId: true,
        method: true,
        success: true,
        ipAddress: true,
        userAgent: true,
        location: true,
        createdAt: true,
        user: ACTOR,
      },
    }),
    prisma.userLogin.count({ where: where as any }),
    /* Counted against the same filter minus the success clause, so one number
       answers "of what you are looking at, how many failed" — a page of
       failures under a failure filter would otherwise always read 100%. */
    prisma.userLogin.count({
      where: Object.fromEntries(Object.entries(where).filter(([key]) => key !== 'success')) as any,
    }),
    /* The same question asked per method, over the filter minus the method
       clause: an operator who narrowed the list to Google still wants to know
       that the password door is the one leaking, and a screen that only showed
       the narrowed row could not say that. */
    prisma.userLogin.groupBy({
      by: ['method'],
      where: Object.fromEntries(Object.entries(where).filter(([key]) => key !== 'method')) as any,
      _count: { _all: true, success: true },
      _max: { createdAt: true },
    }),
  ]);
  return {
    rows,
    total,
    page,
    limit,
    failures: total - failures,
    methods: byMethod
      .map((group) => ({
        method: group.method,
        total: group._count._all,
        // `_count.success` counts the rows where success is truthy — the
        // failures are the difference, not a second guess.
        succeeded: (group._count as any).success ?? 0,
        lastAt: group._max.createdAt ?? null,
      }))
      .sort((a, b) => b.total - a.total),
  };
}

/** The Devices overview. One aggregate rather than five pages, because the
 *  questions on that screen ("how much of this is live, how much is stale")
 *  are counts over the whole table and must not be estimated from a page. */
export async function deviceSummary() {
  const now = new Date();
  const [devices, totalDevices, liveSessions, totalSessions, push, passkeys, logins, failedLogins, accounts] =
    await Promise.all([
      prisma.userDevice.count({ where: { status: 'active' } }),
      prisma.userDevice.count(),
      prisma.userSession.count({
        where: { status: 'active', revokedAt: null, expiresAt: { gt: now } },
      }),
      prisma.userSession.count(),
      prisma.pushSubscription.count(),
      prisma.passkey.count(),
      prisma.userLogin.count({ where: { createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }),
      prisma.userLogin.count({
        where: {
          createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) },
          success: false,
        },
      }),
      prisma.user.count(),
    ]);

  /** The accounts holding more than one live session — the row an operator
   *  acts on, since a session that exists once is nobody's problem.
   *
   *  Raw SQL rather than `groupBy … having`, because the answer is a count of
   *  the groups and not the groups: a page of accounts with several sessions
   *  would quietly turn "3 accounts are signed in twice" into "2", and an
   *  aggregate that lies at scale is exactly the thing this console forbids. */
  const shared = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM (
      SELECT user_id
      FROM user_sessions
      WHERE status = 'active' AND revoked_at IS NULL AND expires_at > ${now}
      GROUP BY user_id
      HAVING count(*) > 1
    ) held`;

  return {
    accounts,
    devices: { active: devices, total: totalDevices },
    sessions: { live: liveSessions, total: totalSessions },
    push,
    passkeys,
    signInWeek: { total: logins, failed: failedLogins },
    sharedAccounts: Number(shared[0]?.n ?? 0),
  };
}

/** The single action this section takes: end one session.
 *
 *  `revokeSession` is the same call the account's own "sign this device out"
 *  button makes, so the console cannot produce a half-revoked session — DB row,
 *  in-process cache, the brain's Redis registry and every open tab of that
 *  account all hear about it through that one door. The operator's id goes into
 *  the audit row: "a session ended" is only useful if somebody can say who
 *  ended it. */
export async function revokeSessionById(
  sessionId: string,
  actor: { id: string; email: string },
): Promise<{ ok: boolean; reason?: string }> {
  const row = await prisma.userSession.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, revokedAt: true, status: true, deviceName: true },
  });
  if (!row) return { ok: false, reason: 'no_such_session' };
  if (row.revokedAt) return { ok: false, reason: 'already_revoked' };

  const { revokeSession } = await import('@/features/auth/session');
  await revokeSession(row.id);

  const { createAuditEvent } = await import('@/features/security/audit');
  await createAuditEvent({
    actorId: actor.id,
    action: 'admin.session_revoked',
    title: `Session ended on ${row.deviceName || 'a device'}`,
    targetType: 'user_session',
    targetId: row.id,
    metadata: { targetUserId: row.userId, targetEmail: null, via: 'admin-console', actorEmail: actor.email },
  });

  return { ok: true };
}
