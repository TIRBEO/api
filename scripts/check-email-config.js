const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const rows = await p.emailConfig.findMany();
  console.log('email_configs rows:', rows.length);
  for (const c of rows) {
    console.log(JSON.stringify({
      id: c.id,
      provider: c.provider,
      apiKey: c.apiKey ? 'SET(***' + c.apiKey.slice(-4) : 'EMPTY',
      enabled: c.enabled,
      fromEmail: c.fromEmail,
      fromName: c.fromName,
    }, null, 2));
  }
  
  // If there's a row with enabled=false, fix it
  for (const c of rows) {
    if (!c.enabled) {
      console.log('FIX: Re-enabling email config', c.id);
      await p.emailConfig.update({ where: { id: c.id }, data: { enabled: true } });
    }
  }
  
  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
