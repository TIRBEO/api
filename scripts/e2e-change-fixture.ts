/**
 * Phase E slice #14 fixture for the change-history endpoints.
 *
 *   snapshot  — prints every account.change_answered row on the test user plus
 *               an activity id belonging to a DIFFERENT user (for the 404 test)
 *   restore   — deletes answer rows written by the run, leaving the ledger the
 *               way it was found
 *
 *   cd apps/api && npx tsx --env-file=.env.local scripts/e2e-change-fixture.ts snapshot
 */
import { prisma } from '@/infrastructure/db/prisma';

const EMAIL = 'e2e.datauser@gmail.com';
const ANSWER_KIND = 'account.change_answered';

async function main() {
  const mode = process.argv[2] || 'snapshot';
  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (!user) {
    console.log(JSON.stringify({ error: 'no test user' }));
    return;
  }

  if (mode === 'kinds') {
    const rows: { kind: string; events: bigint }[] = await prisma.$queryRawUnsafe(
      `SELECT kind, count(*)::bigint AS events FROM "activity"."activity_events" GROUP BY kind ORDER BY events DESC`,
    );
    const foreign = await prisma.activityEvent.findFirst({
      where: {
        userId: { not: user.id },
        AND: [{ kind: { not: ANSWER_KIND } }, { kind: { not: { contains: 'login' } } }],
      },
      select: { id: true, kind: true },
    });
    console.log(JSON.stringify({ foreign: foreign?.id, foreignKind: foreign?.kind, kinds: rows.map((row) => `${row.kind}=${row.events}`) }, null, 2));
    return;
  }

  if (mode === 'restore') {
    const mine = (process.env.E2E_ANSWER_IDS || '').split(',').filter(Boolean);
    const deleted = mine.length
      ? await prisma.activityEvent.deleteMany({ where: { userId: user.id, id: { in: mine } } })
      : { count: 0 };
    const leftover = await prisma.activityEvent.findMany({
      where: { userId: user.id, kind: ANSWER_KIND },
      select: { id: true, createdAt: true },
    });
    console.log(JSON.stringify({ deleted: deleted.count, remaining: leftover }, null, 0));
    return;
  }

  const answers = await prisma.activityEvent.findMany({
    where: { userId: user.id, kind: ANSWER_KIND },
    select: { id: true, createdAt: true, metadata: true },
    orderBy: { createdAt: 'desc' },
  });
  const other = await prisma.activityEvent.findFirst({
    where: { kind: ANSWER_KIND, NOT: { userId: user.id } },
    select: { id: true, userId: true },
  });
  const foreignChange = await prisma.activityEvent.findFirst({
    where: { userId: { not: user.id }, kind: { not: ANSWER_KIND }, severity: 'info' },
    select: { id: true, kind: true, userId: true },
  });
  const mine = await prisma.activityEvent.findMany({
    where: { userId: user.id, kind: { not: ANSWER_KIND } },
    select: { id: true, kind: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  console.log(JSON.stringify({
    userId: user.id,
    answers,
    otherUserAnswer: other,
    foreignChange,
    myChanges: mine.length,
    myChangeIds: mine.map((row) => row.id),
    kinds: [...new Set(mine.map((row) => row.kind))],
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(0));
