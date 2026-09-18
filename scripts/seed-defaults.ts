import { prisma } from '@/infrastructure/db/prisma';

async function main() {
  console.log('[SEED] Nothing to seed — all defaults are code-owned now.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
