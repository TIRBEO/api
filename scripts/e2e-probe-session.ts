import { prisma } from '@/infrastructure/db/prisma';

const SID = process.argv[2];

async function main() {
  const s = SID
    ? await prisma.userSession.findUnique({
        where: { id: SID },
        select: { id: true, status: true, revokedAt: true, expiresAt: true, lastUsedAt: true, userId: true },
      })
    : null;
  console.log(JSON.stringify(s, null, 2));
  const count = await prisma.userSession.count({ where: { userId: s?.userId ?? '' } });
  console.log('sessions for user:', count);
}

main().finally(() => process.exit(0));
