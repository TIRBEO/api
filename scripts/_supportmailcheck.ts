/**
 * Live proof of the staff copy of a support request: it must arrive from the
 * account's own handle on the verified identity domain, reply into the
 * mailbox the person reads, and carry the request's reference as the thread.
 *
 *   npx tsx --env-file=.env.local scripts/_supportmailcheck.ts [address]
 */
require('dotenv').config({ path: '.env.local' });
import { sendTemplateEmail, supportSender } from '../features/email/email';
import { tirbeoEmailFor } from '../features/identity/tirbeo';

async function main() {
  const to = process.argv[2] || 'bishnuneup4ne@gmail.com';
  const handle = 'bishnu';
  const identity = tirbeoEmailFor(handle);
  const refCode = 'demo-sndchk';
  const sender = supportSender(identity, 'Bishnu Neupane');
  console.log('identity:', identity, '| sender resolved:', JSON.stringify(sender));

  const r = await sendTemplateEmail(to, 'support_request_admin', {
    subject: 'Sender check from the settings sheet',
    senderName: 'Bishnu Neupane',
    contact: to,
    account: identity,
    receivedAt: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    device: 'Chrome on Linux',
    origin: '203.0.113.42 · Kathmandu, Nepal',
    refCode,
    message: 'This is the staff copy rendered straight from the pipeline — no account action needed.',
    dashboardUrl: 'https://admin.tirbeo.com',
    replyHref: `mailto:${to}?subject=${encodeURIComponent(`Re: ${refCode}`)}`,
    replyLabel: `Reply to ${to}`,
  }, {
    ...sender,
    replyTo: to,
    threadId: refCode,
    skipSuppression: true,
  });
  console.log('SEND:', JSON.stringify(r));
  process.exit(r.success ? 0 : 1);
}
main().catch((e) => { console.error('ERR', e?.message || e); process.exit(1); });
