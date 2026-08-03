require('dotenv').config({ path: '.env.local', quiet: true });
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
const adapter = new PrismaPg({ connectionString });
const p = new PrismaClient({ adapter });
(async () => {
  try {
    await p.$connect();
    const r = await p.$queryRaw`SELECT 1 AS ok`;
    console.log('DB OK: ' + r[0].ok);
  } catch (e) {
    console.log('DB FAIL: ' + String(e.message).split('\n')[0]);
  } finally {
    await p.$disconnect();
    process.exit(0);
  }
})();
