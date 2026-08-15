import { prisma } from './lib/db/prisma';
const r = await prisma.user.update({
  where: { email: 'tirbeo@gmail.com' },
  data: { secondaryEmail: 'tirbeo.recovery@gmail.com', secondaryEmailVerified: true },
  select: { email: true, secondaryEmail: true },
});
console.log('updated:', JSON.stringify(r));
await prisma.$disconnect();
