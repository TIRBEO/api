/**
 * Seed/cleanup for the passkey E2E test. Run from apps/api:
 *   npx tsx --env-file=.env.local scripts/seed-e2e-passkey-user.ts            (seed)
 *   npx tsx --env-file=.env.local scripts/seed-e2e-passkey-user.ts --cleanup  (remove)
 */
import { prisma } from '@/infrastructure/db/prisma';
import * as argon2 from 'argon2';
const EMAIL = 'e2e-passkey-test@tirbeo.test';

async function main() {
  const cleanup = process.argv.includes('--cleanup');
  if (cleanup) {
    const u = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
    if (u) {
      await prisma.user.delete({ where: { id: u.id } }); // passkeys + sessions cascade
      console.log(`CLEANUP: deleted user ${u.id}`);
    } else {
      console.log('CLEANUP: user not found');
    }
    return;
  }

  const passwordHash = await argon2.hash('E2ePasskeyTest!42', {
    type: argon2.argon2id, memoryCost: 2 ** 16, timeCost: 3, parallelism: 1,
  });
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: { passwordHash, emailVerified: true, isBanned: false, isSuspended: false, deletedAt: null },
    create: {
      email: EMAIL,
      passwordHash,
      name: 'E2E Passkey Test',
      emailVerified: true,
      adminRole: 'admin',
      language: 'en',
    },
    select: { id: true, email: true, adminRole: true },
  });
  console.log(`SEEDED: ${JSON.stringify(user)}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => { void prisma.$disconnect?.(); });
