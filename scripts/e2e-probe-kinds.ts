import { prisma } from '@/infrastructure/db/prisma';

async function main() {
  const rows: { kind: string; n: number }[] = await prisma.$queryRawUnsafe(
    `select kind, count(*)::int as n from "activity".activity_events group by kind order by n desc limit 60`,
  );
  for (const r of rows) console.log(String(r.n).padStart(6), r.kind);
  const logins: { method: string; n: number }[] = await prisma.$queryRawUnsafe(
    `select method, count(*)::int as n from "security".user_logins group by method order by n desc`,
  );
  console.log('--- logins');
  for (const r of logins) console.log(String(r.n).padStart(6), r.method);
}

main().finally(() => process.exit(0));
