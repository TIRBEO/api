/**
 * The deletion sweep, against an in-memory stand-in of the tables it touches.
 *
 * Three things are worth locking down because each is a way this job used to
 * quietly stop working:
 *
 *   1. Which requests are picked up — due, not cancelled, not executed.
 *   2. That a delete which REFUSES leaves the request due. The old version
 *      stamped `executedAt` first and then failed, so the account stayed on
 *      file forever and no later run ever asked again.
 *   3. That the rows holding the foreign keys go before `users` is touched —
 *      the blocklist entry an account filed, a support ticket, media it
 *      uploaded.
 *
 * Only the database is stubbed; the sweep is otherwise the real code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Fixture ────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const isRange = (v: any) =>
    !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

  const cmp = (a: any, b: any) => (a instanceof Date ? a.getTime() : a) <= (b instanceof Date ? b.getTime() : b);

  /** Match a row against the few where clauses this job actually writes. */
  const matches = (row: any, where: any) =>
    Object.entries(where || {}).every(([k, v]: [string, any]) => {
      if (isRange(v)) {
        if ('in' in v) return v.in.includes(row[k]);
        if ('lte' in v) return cmp(row[k], v.lte);
        if ('lt' in v) return row[k] < v.lt;
        if ('gte' in v) return row[k] >= v.gte;
      }
      return row[k] === v;
    });

  const table = (name: string, rows: () => any[]) => ({
    deleteMany: vi.fn(async ({ where }: any = {}) => {
      if (failing.has(name)) throw new Error(`${name} is unreachable`);
      const kept = rows().filter((row) => !matches(row, where));
      const removed = rows().length - kept.length;
      rows().splice(0, rows().length, ...kept);
      calls.push(name);
      return { count: removed };
    }),
  });

  /** Table names a test wants the schema lookup to refuse to find. */
  const missing = new Set<string>();
  /** Table names whose delete throws. */
  const failing = new Set<string>();
  /** Every table the sweep removed rows from, in call order. */
  const calls: string[] = [];
  /** Raw SQL the modelless tables were deleted with. */
  const rawSql: string[] = [];

  const rows = {
    otps: [] as any[],
    passkeys: [] as any[],
    notifications: [] as any[],
    sessions: [] as any[],
    securityEvents: [] as any[],
    emailJobs: [] as any[],
    emailDeliveries: [] as any[],
    blocklist: [] as any[],
    spentTokens: [] as any[],
    emails: [] as any[],
    deletionRequests: [] as any[],
    /** user id -> row; `user.delete` throws for any id in `protectedUsers`. */
    users: [] as any[],
    protectedUsers: new Set<string>(),
    userDeleteCalls: [] as string[],
  };

  const prisma = {
    otp: table('otps', () => rows.otps),
    passkey: table('passkeys', () => rows.passkeys),
    notification: table('notifications', () => rows.notifications),
    securityEvent: table('security_events', () => rows.securityEvents),
    email_jobs: table('email_jobs', () => rows.emailJobs),
    email_deliveries: table('email_deliveries', () => rows.emailDeliveries),
    blocklist: table('blocklist', () => rows.blocklist),
    refreshTokenSpent: table('refresh_token_spent', () => rows.spentTokens),
    userSession: {
      ...table('user_sessions', () => rows.sessions),
      findMany: vi.fn(async ({ where }: any = {}) =>
        rows.sessions.filter((row) => matches(row, where)).map((row) => ({ id: row.id }))),
    },
    userEmail: {
      findFirst: vi.fn(async ({ where }: any = {}) =>
        rows.emails.find((row) => matches(row, where)) ?? null),
    },
    user: {
      delete: vi.fn(async ({ where }: any) => {
        rows.userDeleteCalls.push(where.id);
        calls.push('users');
        if (rows.protectedUsers.has(where.id)) {
          throw Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' });
        }
        const kept = rows.users.filter((row) => row.id !== where.id);
        rows.users.splice(0, rows.users.length, ...kept);
        return { id: where.id };
      }),
    },
    userDeletionRequest: {
      findMany: vi.fn(async ({ where, take, orderBy }: any = {}) => {
        const due = rows.deletionRequests.filter((row) => matches(row, where));
        const asc = orderBy?.finalAt === 'asc' ? 1 : -1;
        due.sort((a, b) => asc * (a.finalAt.getTime() - b.finalAt.getTime()));
        return take ? due.slice(0, take) : due;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.deletionRequests.find((r) => r.userId === where.userId);
        if (row) Object.assign(row, data);
        calls.push('user_deletion_requests');
        return row;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    /** `SELECT table_schema FROM information_schema.tables WHERE table_name = $1` */
    $queryRawUnsafe: vi.fn(async (_sql: string, name: string) =>
      missing.has(name) ? [] : [{ table_schema: 'public' }]),
    $executeRawUnsafe: vi.fn(async (sql: string, userId: string) => {
      const name = /FROM "public"\."([a-z_]+)"/i.exec(sql)?.[1] ?? 'unknown';
      if (failing.has(name)) throw new Error(`${name} refuses the delete`);
      rawSql.push(`${name}:${userId}`);
      calls.push(name);
      return 1;
    }),
  };

  return { prisma, rows, calls, rawSql, missing, failing };
});

vi.mock('@/infrastructure/db/prisma', () => ({ prisma: mocks.prisma }));

/** Re-imported per test: `quoteTable` memoises schema lookups in module scope,
    and the "table is absent" case must not leak into its neighbours. */
async function loadSweep() {
  vi.resetModules();
  return import('@/jobs/jobs-permanent-deletion');
}

const NOW = new Date('2026-03-01T00:00:00.000Z');

function request(userId: string, over: Partial<any> = {}) {
  return {
    userId,
    finalAt: new Date('2026-02-01T00:00:00.000Z'),
    cancelledAt: null,
    executedAt: null,
    ...over,
  };
}

/** Every row the account could be holding elsewhere, pointed at `userId`. */
function seedAccount(userId: string) {
  mocks.rows.users.push({ id: userId });
  mocks.rows.otps.push({ userId });
  mocks.rows.passkeys.push({ userId });
  mocks.rows.notifications.push({ userId });
  mocks.rows.sessions.push({ id: `${userId}-sess`, userId });
  mocks.rows.securityEvents.push({ userId });
  mocks.rows.emailJobs.push({ userId });
  mocks.rows.emailDeliveries.push({ userId });
  mocks.rows.blocklist.push({ blockedBy: userId });
  mocks.rows.spentTokens.push({ sessionId: `${userId}-sess` });
  mocks.rows.emails.push({ userId, kind: 'primary', address: `${userId}@tirbeo.dev` });
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.rawSql.length = 0;
  mocks.missing.clear();
  mocks.failing.clear();
  mocks.rows.userDeleteCalls.length = 0;
  mocks.rows.protectedUsers.clear();
  for (const rows of [
    mocks.rows.otps, mocks.rows.passkeys, mocks.rows.notifications, mocks.rows.sessions,
    mocks.rows.securityEvents, mocks.rows.emailJobs, mocks.rows.emailDeliveries,
    mocks.rows.blocklist, mocks.rows.spentTokens, mocks.rows.emails,
    mocks.rows.deletionRequests, mocks.rows.users,
  ]) {
    rows.length = 0;
  }
});

// ─── 1. Which requests are due ──────────────────────────────────────

describe('runDeletionSweep — the batch', () => {
  it('takes only requests that are due, uncancelled and unexecuted', async () => {
    const { runDeletionSweep } = await loadSweep();
    seedAccount('due');
    mocks.rows.deletionRequests.push(
      request('due'),
      request('not-yet', { finalAt: new Date('2026-06-01T00:00:00.000Z') }),
      request('reconsidered', { cancelledAt: new Date('2026-02-05T00:00:00.000Z') }),
      request('already-gone', { executedAt: new Date('2026-02-02T00:00:00.000Z') }),
    );

    expect(await runDeletionSweep(NOW)).toEqual({ deleted: 1 });
    expect(mocks.rows.userDeleteCalls).toEqual(['due']);
  });

  it('oldest first, and bounded by the batch cap', async () => {
    const { runDeletionSweep } = await loadSweep();
    seedAccount('a');
    seedAccount('b');
    seedAccount('c');
    mocks.rows.deletionRequests.push(
      request('b', { finalAt: new Date('2026-01-20T00:00:00.000Z') }),
      request('a', { finalAt: new Date('2026-01-10T00:00:00.000Z') }),
      request('c', { finalAt: new Date('2026-02-10T00:00:00.000Z') }),
    );

    expect(await runDeletionSweep(NOW, 2)).toEqual({ deleted: 2 });
    expect(mocks.rows.userDeleteCalls).toEqual(['a', 'b']);
  });

  it('does nothing when nothing is due', async () => {
    const { runDeletionSweep } = await loadSweep();
    mocks.rows.deletionRequests.push(request('later', { finalAt: new Date('2026-09-01T00:00:00.000Z') }));

    expect(await runDeletionSweep(NOW)).toEqual({ deleted: 0 });
    expect(mocks.rows.userDeleteCalls).toEqual([]);
  });
});

// ─── 2. A failed delete stays due ───────────────────────────────────

describe('runDeletionSweep — a refusal is not a completion', () => {
  it('leaves the request unstamped so the next run retries it', async () => {
    const { runDeletionSweep } = await loadSweep();
    seedAccount('stuck');
    mocks.rows.deletionRequests.push(request('stuck'));
    /* What the real database threw: a row somewhere still names the account. */
    mocks.rows.protectedUsers.add('stuck');

    expect(await runDeletionSweep(NOW)).toEqual({ deleted: 0 });
    expect(mocks.rows.deletionRequests[0].executedAt).toBeNull();
  });

  it('keeps going with the rest of the batch', async () => {
    const { runDeletionSweep } = await loadSweep();
    seedAccount('stuck');
    seedAccount('clean');
    mocks.rows.deletionRequests.push(request('clean'), request('stuck'));
    mocks.rows.protectedUsers.add('stuck');

    expect(await runDeletionSweep(NOW)).toEqual({ deleted: 1 });
    /* The one that refused is still on file — that is the whole point. */
    expect(mocks.rows.users.map((u: any) => u.id)).toEqual(['stuck']);
    expect(mocks.rows.deletionRequests.find((r) => r.userId === 'stuck').executedAt).toBeNull();
  });

  it('reports what refused instead of swallowing it', async () => {
    const { permanentlyDeleteUser } = await loadSweep();
    seedAccount('stuck');
    mocks.rows.protectedUsers.add('stuck');

    await expect(permanentlyDeleteUser('stuck', NOW)).rejects.toThrow(/still on file/);
  });

  it('the job wrapper answers with a count, never a throw', async () => {
    const { permanentDeletionJob } = await loadSweep();
    vi.spyOn(mocks.prisma.userDeletionRequest, 'findMany').mockRejectedValueOnce(
      new Error('database is down'),
    );

    expect(await permanentDeletionJob()).toEqual({ deleted: 0 });
  });
});

// ─── 3. Order of operations ─────────────────────────────────────────

describe('permanentlyDeleteUser — the blockers go first', () => {
  it('prunes every referring row before touching users', async () => {
    const { permanentlyDeleteUser } = await loadSweep();
    seedAccount('u1');

    await permanentlyDeleteUser('u1', NOW);

    for (const blocker of ['otps', 'passkeys', 'notifications', 'security_events', 'email_jobs', 'email_deliveries', 'blocklist', 'ticket_messages', 'tickets', 'cdn_files', 'media']) {
      expect(mocks.calls, `${blocker} should be pruned`).toContain(blocker);
      expect(mocks.calls.indexOf(blocker), `${blocker} before users`).toBeLessThan(mocks.calls.indexOf('users'));
    }
  });

  it('clears spent refresh tokens while their sessions can still be named', async () => {
    const { permanentlyDeleteUser } = await loadSweep();
    seedAccount('u1');

    await permanentlyDeleteUser('u1', NOW);

    expect(mocks.rows.spentTokens).toEqual([]);
    expect(mocks.calls.indexOf('user_sessions')).toBeLessThan(mocks.calls.indexOf('refresh_token_spent'));
  });

  it('resolves the modelless tables through the database, not a guess', async () => {
    const { permanentlyDeleteUser } = await loadSweep();
    seedAccount('u1');

    await permanentlyDeleteUser('u1', NOW);

    expect(mocks.rawSql).toEqual([
      'ticket_messages:u1',
      'tickets:u1',
      'cdn_files:u1',
      'media:u1',
    ]);
  });

  it('a table the database does not have is skipped, not fatal', async () => {
    const { permanentlyDeleteUser } = await loadSweep();
    seedAccount('u1');
    mocks.missing.add('media');

    await permanentlyDeleteUser('u1', NOW);

    expect(mocks.rawSql).not.toContain('media:u1');
    expect(mocks.rows.users).toEqual([]);
  });

  it('a blocker that will not delete is reported, and the account still goes', async () => {
    const { permanentlyDeleteUser } = await loadSweep();
    seedAccount('u1');
    mocks.failing.add('notifications');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await permanentlyDeleteUser('u1', NOW);

    expect(mocks.rows.users).toEqual([]);
    expect(log.mock.calls.at(-1)?.join(' ')).toContain('Residual: notifications');
    log.mockRestore();
  });

  it('deletes the account and its rows, and stamps nothing afterwards', async () => {
    const { permanentlyDeleteUser } = await loadSweep();
    seedAccount('u1');
    mocks.rows.deletionRequests.push(request('u1'));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await permanentlyDeleteUser('u1', NOW);

    expect(mocks.rows.users).toEqual([]);
    expect(mocks.rows.blocklist).toEqual([]);
    expect(mocks.rows.sessions).toEqual([]);
    /* The request row is the database's to cascade; writing executedAt here is
       how a failed sweep used to hide itself. */
    expect(mocks.calls).not.toContain('user_deletion_requests');
  });
});
