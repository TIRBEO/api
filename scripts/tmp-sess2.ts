import { prisma } from '../infrastructure/db/prisma';
async function main() {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `select s.id, s.expires_at, s.revoked_at, s.status, s.created_at,
            (s.expires_at > now()) as live, (s.revoked_at is null) as unreoked
       from user_sessions s order by s.created_at desc limit 8`);
  for (const r of rows) console.log(JSON.stringify({ id: String(r.id).slice(0,8), live: r.live, unreoked: r.unreoked, status: r.status }));
  await prisma.$disconnect();
}
main().catch((e) => { console.error('ERR', e?.message ?? e); process.exit(1); });
