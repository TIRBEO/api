/**
 * Phase E slice #11 clean-up.
 *
 *   mark    — prints the newest activity row on the test user, i.e. where the
 *             account stood before the harness ran
 *   restore — deletes passkey rows written after that mark, leaving the ledger
 *             as it was found
 *
 *   cd apps/api && npx tsx --env-file=.env.local scripts/e2e-passkey-audit.ts mark
 */
import { prisma } from '@/infrastructure/db/prisma';

const EMAIL = 'e2e.datauser@gmail.com';

async function main() {
  const mode = process.argv[2] || 'mark';
  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (!user) {
    console.log(JSON.stringify({ error: 'no test user' }));
    return;
  }

  const all = await prisma.activityEvent.findMany({
    where: { userId: user.id },
    select: { id: true, kind: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  if (mode === 'mark') {
    console.log(JSON.stringify({
      total: all.length,
      newest: all[0]?.createdAt.toISOString() ?? null,
      passkey: all.filter((row) => /passkey/i.test(row.kind)).map((row) => row.kind),
    }, null, 2));
    return;
  }

  const since = new Date(process.env.E2E_PASSKEY_SINCE as string);
  if (Number.isNaN(since.getTime())) {
    console.log(JSON.stringify({ error: 'set E2E_PASSKEY_SINCE to the mark' }));
    return;
  }
  const doomed = all.filter((row) => /passkey/i.test(row.kind) && row.createdAt > since);
  if (doomed.length) await prisma.activityEvent.deleteMany({ where: { id: { in: doomed.map((row) => row.id) } } });
  const after = await prisma.activityEvent.findMany({ where: { userId: user.id }, select: { kind: true } });
  const keys = await prisma.passkey.count({ where: { userId: user.id } });
  console.log(JSON.stringify({
    deleted: doomed.length,
    deletedKinds: doomed.map((row) => row.kind),
    remainingEvents: after.length,
    remainingPasskeys: keys,
  }, null, 2));
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
