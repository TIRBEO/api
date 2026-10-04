/**
 * Restores the connected-apps test state after the Phase E slice #9 run:
 * puts the GitHub link back on the test user and removes everything the
 * disconnect wrote (security-feed row, notification).
 *
 *   cd apps/api && npx tsx --env-file=.env.local scripts/e2e-reset-integrations.ts
 */
import { prisma } from '@/infrastructure/db/prisma';

const EMAIL = 'e2e.datauser@gmail.com';
const GITHUB_ID = 'gh-e2e-12345';

async function main() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (!user) {
    console.log('no test user — nothing to restore');
    return;
  }
  const uid = user.id;

  await prisma.user.update({ where: { id: uid }, data: { githubId: GITHUB_ID } });

  const events = await prisma.activityEvent.deleteMany({
    where: { userId: uid, kind: 'security.app_disconnected' },
  });
  const notes = await prisma.notification.deleteMany({
    where: { userId: uid, title: { contains: 'disconnected' } },
  });

  const after = await prisma.user.findUnique({
    where: { id: uid },
    select: { googleId: true, githubId: true, discordId: true },
  });
  console.log(`github link restored, ${events.count} event row(s) + ${notes.count} notification(s) removed`);
  console.log('provider ids:', after);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(0));
