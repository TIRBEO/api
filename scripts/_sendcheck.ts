/**
 * Live send check: renders a real template and puts it in a real inbox.
 *
 *   npx tsx --env-file=.env.local scripts/_sendcheck.ts [address] [template]
 *
 * Defaults to a signup OTP to the address in ADMIN_FROM_EMAIL's mailbox owner.
 * It goes through sendTemplateEmail — the same path every product mail takes,
 * suppression gate and sender resolution included — so what it proves is the
 * pipeline, not just the transport.
 */
require('dotenv').config({ path: '.env.local' });
import { sendTemplateEmail } from './../features/email/email';
import { prisma } from './../infrastructure/db/prisma';

async function main() {
  const to = process.argv[2] || 'bishnuneup4ne@gmail.com';
  const template = process.argv[3] || 'signup_otp';
  const r = await sendTemplateEmail(to, template, { otp: '482913', lifetimeMinutes: '15' });
  console.log('SEND:', JSON.stringify(r));

  const job = await prisma.email_jobs.findFirst({ orderBy: { createdAt: 'desc' } });
  const row = await prisma.email_deliveries.findFirst({ orderBy: { createdAt: 'desc' } });
  console.log('JOB:', JSON.stringify({ status: job?.status, kind: job?.kind, to: job?.toAddress, err: job?.lastError }));
  console.log('ROW:', JSON.stringify({
    status: row?.status,
    event: row?.event,
    provider: row?.provider,
    to: row?.toEmail,
    key: row?.eventKey,
    subject: row?.subject,
    providerId: row?.providerId,
  }));
  process.exit(r.success ? 0 : 1);
}
main().catch(e => { console.error('ERR', e.message || e); process.exit(1); });
