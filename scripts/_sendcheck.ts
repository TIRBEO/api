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
import { factPlate } from './../features/email/email-fragments';

/**
 * Fixtures for every variable any template asks for.
 *
 * The real senders build these from a session or a job row; the harness has
 * neither, and a mail rendered without them used to arrive with the braces
 * still in it. Unused keys are ignored by `renderTemplate`, so one flat object
 * covers every template in the catalogue.
 */
const fixture = (to: string): Record<string, string> => {
  const when = new Date().toLocaleString();
  const ua = 'Chrome on macOS';
  const rows = (pairs: Array<[string, string]>): string =>
    `<div style="font-size:15px;line-height:26px">${pairs.map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`).join('')}</div>`;
  return {
    otp: '482913',
    lifetimeMinutes: '15',
    primaryEmail: to,
    recoveryEmail: 'recovery@example.com',
    magicLink: 'https://tirbeo.com/auth/magic?token=example',
    resetUrl: 'https://tirbeo.com/auth/reset?token=example',
    recoveryUrl: 'https://tirbeo.com/auth/recover?token=example',
    twoFactorUrl: 'https://myprofile.tirbeo.com/settings/security',
    accountsUrl: 'https://accounts.tirbeo.com',
    dashboardUrl: 'https://myprofile.tirbeo.com',
    actionUrl: 'https://myprofile.tirbeo.com/settings/security',
    actionLabel: 'Turn on two-step verification',
    tipTitle: 'Your account is missing two-step verification',
    tipBody: 'One extra step at sign-in is the difference between a stolen password and a stolen account.',
    device: ua,
    location: 'San Francisco, CA',
    loginTime: when,
    changedAt: when,
    completedAt: when,
    exportedAt: when,
    ipAddress: '203.0.113.42',
    dateLabel: '14 November 2026',
    username: 'bishnu',
    password: 'Tirbeo-Example-2026',
    sentFor: to,
    count: '4',
    periodWord: 'week',
    periodLabel: '12–19 October',
    statusType: 'restricted',
    reason: 'A payment method needs to be confirmed.',
    suspendedUntil: '14 November 2026',
    suspendedNextStep: 'Confirm your payment method to restore full access.',
    maintenanceTitle: 'Scheduled database maintenance',
    maintenanceMessage: 'Tirbeo will be briefly unavailable while we move to faster storage.',
    completionMessage: 'Everything is back and running on the new hardware.',
    startTime: 'Saturday 02:00 UTC',
    estimatedEnd: 'Saturday 04:00 UTC',
    duration: 'About 2 hours',
    digestItems: rows([['Form responses', '3 new'], ['Profile views', '11']]),
    activitySection: rows([['Workspace', '1 change']]),
    statRows: rows([['Sign-ins', '6'], ['Form responses', '12'], ['Profile views', '31']]),
    suspiciousSection: rows([['Unusual sign-ins', '1 — review it']]),
    activitySummary: rows([['Last visit', '24 days ago']]),
    details: factPlate([
      ['Account', 'someone@example.com'],
      ['Reference', 'a1b2-c3d4-e5f6-7a8b'],
      ['When', when],
      ['Device', ua],
      ['Address', '203.0.113.42'],
    ]),
    refCode: 'a1b2-c3d4-e5f6-7a8b',
    ticketSubject: 'A sign-in I don’t recognise',
    receivedAt: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    // The staff copy of a request: who wrote, where the answer goes, and the
    // one action the mail offers.
    senderName: 'Bishnu',
    contact: to,
    account: 'bishnu@tirbeo.com',
    origin: '203.0.113.42 · San Francisco, CA',
    replyHref: `mailto:${to}?subject=Re%3A%20a1b2-c3d4-e5f6-7a8b`,
    replyLabel: `Reply to ${to}`,
    replyHtml: '<p style="margin:0 0 12px;font-size:15px;line-height:25px;color:#344054">We found the session you asked about — it was you, on a phone, in Kathmandu. Nothing on the account was changed, and we have left it signed in.</p><p style="margin:0;font-size:15px;line-height:25px;color:#344054">If that was not you, turn on two-step verification and end the other sessions from the security screen.</p>',
    subject: 'Three failed admin sign-ins in one minute',
    message: 'The same IP tried four administrator accounts in 60 seconds and failed every one of them.',
    title: 'Two-step verification is now on by default',
    ctaUrl: 'https://myprofile.tirbeo.com/settings/security',
    ctaLabel: 'See how it works',
  };
};

async function main() {
  const to = process.argv[2] || 'bishnuneup4ne@gmail.com';
  const template = process.argv[3] || 'signup_otp';
  const r = await sendTemplateEmail(to, template, fixture(to));
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
