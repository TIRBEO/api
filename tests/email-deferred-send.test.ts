/**
 * `sendTemplateEmailAfter` is what ten call sites now lean on to keep mail off
 * the response path, so the two things it promises are worth pinning:
 *
 *   1. inside a request it SCHEDULES the send — the handler gets its answer
 *      back before the mail provider is even asked;
 *   2. outside one (the cron jobs, the standalone server) it still sends, and
 *      never throws.
 *
 * The send itself is driven to its first database read and no further: a Proxy
 * over `prisma` records which model was touched without needing a schema, so
 * "was the mail pipeline entered at all" is a count rather than a guess.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  after: vi.fn((..._args: unknown[]): void => {}),
  reads: [] as string[],
  tasks: [] as Array<() => unknown>,
}));

vi.mock('next/server', () => ({
  after: mocks.after,
  NextResponse: { json: (b: any) => b },
  NextRequest: class {},
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: new Proxy({}, {
    get: (_t, model) => new Proxy({}, {
      get: (_t2, method) => async () => { mocks.reads.push(`${String(model)}.${String(method)}`); return null; },
    }),
  }),
}));

import { sendTemplateEmailAfter } from '@/features/email/email';

beforeEach(() => {
  mocks.after.mockReset();
  mocks.reads.length = 0;
  mocks.tasks.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sendTemplateEmailAfter', () => {
  it('does not touch the mail pipeline before the response is done', () => {
    // The platform's contract: `after` returns immediately and runs the task
    // later. If the send happened here instead, the caller is paying for it.
    mocks.after.mockImplementation(() => {});
    sendTemplateEmailAfter('alice@example.com', 'welcome', { name: 'Alice' });
    expect(mocks.reads).toEqual([]);
  });

  it('sends exactly once, when the deferred task runs', async () => {
    mocks.after.mockImplementation((task: unknown) => { mocks.tasks.push(task as () => unknown); });
    sendTemplateEmailAfter('alice@example.com', 'welcome', { name: 'Alice' });
    expect(mocks.tasks).toHaveLength(1);

    await mocks.tasks[0]();
    expect(mocks.reads.length).toBeGreaterThan(0);
  });

  it('falls back to an inline send outside a request scope, and survives it', async () => {
    // Next throws synchronously from `after` when there is no request store —
    // which is every job. The mail must go anyway, and the job that wants to
    // await it must be handed something it can await.
    mocks.after.mockImplementation(() => { throw new Error('`after` was called outside a request scope'); });
    const result = sendTemplateEmailAfter('alice@example.com', 'welcome', { name: 'Alice' });
    await expect(Promise.resolve(result)).resolves.toBeUndefined();
    expect(mocks.reads.length).toBeGreaterThan(0);
  });

  it('never rejects the caller, whichever way the send goes', async () => {
    mocks.reads.length = 0;
    mocks.after.mockImplementation(() => { throw new Error('outside a request scope'); });
    await expect(Promise.resolve(
      sendTemplateEmailAfter('nobody.invalid', 'welcome', { name: 'Nobody' }),
    )).resolves.toBeUndefined();
  });
});
