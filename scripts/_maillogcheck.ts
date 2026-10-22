import { prisma } from '@/infrastructure/db/prisma';

async function main() {
  const rows = await prisma.email_deliveries.findMany({
    where: { OR: [{ event: { contains: 'support' } }, { eventKey: { contains: 'support' } }] },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { userId: true, toEmail: true, event: true, eventKey: true, subject: true, status: true, createdAt: true },
  });
  console.log(JSON.stringify(rows, null, 1));
}
main().finally(() => process.exit(0));
