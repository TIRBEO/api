require('dotenv').config({ path: '.env.local' });
import { sendEmail } from './../features/email/email';
import { prisma } from './../infrastructure/db/prisma';

async function main() {
  const r = await sendEmail(
    'bishnuneup4ne@gmail.com',
    'Tirbeo pipeline test',
    '<h2>Hello</h2><p>This confirms the API email pipeline works.</p>',
    { templateName: 'notification_test', metadata: { test: true, source: 'opencode' } }
  );
  console.log('SEND:', JSON.stringify(r));
  const last = await prisma.email_deliveries.findFirst({ orderBy: { createdAt: 'desc' } });
  console.log('ROW:', JSON.stringify({ id: last?.id, status: last?.status, eventKey: last?.eventKey }));
  process.exit(0);
}
main().catch(e => { console.error('ERR', e.message || e); process.exit(1); });
