import { prisma } from '@/infrastructure/db/prisma';

/**
 * The owner's answer to "was this you", written as an event of its own.
 *
 * Storing the answer in the same ledger it is about means it survives the
 * device it was given on, is dated by the server, and can't be quietly edited
 * afterwards — which is the only reason an answer is worth keeping.
 *
 * The answer is about a ROW, and the row can be either kind:
 *   • a change — an activity_events row (password changed, two-factor on),
 *     addressed by its own id;
 *   • a sign-in — a user_logins row, addressed by its own id. The sign-in
 *     ledger has no review column, but the answer does not need one: it lives
 *     here, keyed by the row it is about, and the ledger reads it back.
 *
 * The module is deliberately dependency-free (prisma only) so both the users
 * feature and the security feature can read the answer without importing each
 * other.
 */

export const CHANGE_ANSWER_KIND = 'account.change_answered';

/** The two answers, and the taking-back of one. `null` clears an answer. */
export type ChangeAnswerValue = 'recognised' | 'not-me' | null;

export type ChangeAnswer = { answer: string; at: string };

/** The newest answer given about each row. Answers are few, so the
    newest-wins fold happens here rather than in SQL. The newest word can be a
    clearing — "I take back what I said" — which has to stop an older answer
    from resurfacing without becoming an answer of its own. */
export async function answerIndex(userId: string): Promise<Map<string, ChangeAnswer>> {
  const rows = await prisma.activityEvent.findMany({
    where: { userId, kind: CHANGE_ANSWER_KIND },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { metadata: true, createdAt: true },
  });
  const index = new Map<string, ChangeAnswer>();
  const settled = new Set<string>();
  for (const row of rows) {
    const meta = (row.metadata || {}) as Record<string, any>;
    const about = typeof meta.about === 'string' ? meta.about : '';
    if (!about || settled.has(about)) continue;
    settled.add(about);
    if (meta.answer !== 'not-me' && meta.answer !== 'recognised') continue;
    index.set(about, { answer: meta.answer, at: row.createdAt.toISOString() });
  }
  return index;
}

/** The answers about these rows only — the join a ledger read needs, without
    asking the index for every answer the account has ever given. */
export async function answersAbout(userId: string, ids: string[]): Promise<Map<string, ChangeAnswer>> {
  if (!ids.length) return new Map();
  const all = await answerIndex(userId);
  const out = new Map<string, ChangeAnswer>();
  for (const id of ids) {
    const answer = all.get(id);
    if (answer) out.set(id, answer);
  }
  return out;
}
