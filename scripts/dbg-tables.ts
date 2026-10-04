import { prisma } from '@/infrastructure/db/prisma';
async function main() {
  const rows: any[] = await prisma.$queryRawUnsafe(`SELECT table_schema, table_name FROM information_schema.tables WHERE table_name ILIKE '%export%' OR table_name ILIKE '%archive%' ORDER BY 1,2`);
  console.log(JSON.stringify(rows));
}
main().finally(() => process.exit(0));
