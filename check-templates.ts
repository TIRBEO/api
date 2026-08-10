import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL || process.env.DIRECT_DATABASE_URL || '' });
const prisma = new PrismaClient({ adapter });

async function main() {
  const count = await prisma.form_templates.count();
  console.log('Templates in DB:', count);
  const templates = await prisma.form_templates.findMany({ select: { id: true, name: true, category: true } });
  templates.forEach(t => console.log(`  - ${t.name} (${t.category})`));
}

main().catch(console.error).finally(() => prisma.$disconnect());
