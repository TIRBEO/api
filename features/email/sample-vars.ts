/**
 * Sample data for previewing templates without sending one.
 *
 * Exists because the admin preview endpoint and the offline render script both
 * need to fill every placeholder in the catalogue, and each had its own list.
 * The endpoint's list had drifted badly — 12 names no template used, and most
 * of the real placeholders missing outright, so most previews on the admin page
 * were showing literal `{{token}}` text where a value should be.
 * One list, checked by a test, is the only way to keep the preview honest.
 *
 * The section slots are built by the same helpers the real senders use
 * (`features/email/email-fragments.ts`), so a preview cannot look nothing like
 * the mail it is standing in for.
 */

export type SampleVarResolver = () => {
  accountsUrl: string;
  dashboardUrl: string;
};

import {
  attentionPanel,
  cardItem,
  listGroup,
  listPlate,
  listRow,
  moreRow,
  unsubscribeSection,
} from '@/features/email/email-fragments';
import { ESSENTIAL_TEMPLATES } from '@/features/email/email-classification';

const URL = 'https://tirbeo.com';

/** Plausible values for every section slot the templates expose. */
const SECTION_VALUES: Record<string, string> = {
  unsubscribeSection: unsubscribeSection(`${URL}/u`),
  digestItems:
    cardItem('New submission on Contact Form', 'Someone filled in your contact form.')
    + cardItem('A reply landed on your ticket', '“We are looking into this now.”'),
  activitySection: cardItem('3 sign-ins this week', 'Last one from Chrome on Linux.'),
  activitySummary: cardItem('You signed in 4 times this week', 'And created 2 projects.'),
  details: cardItem('Signed in from a device we have not seen before'),
  statRows: listPlate(
      listGroup('Sign-ins', 12, listRow('Signed in with Password', '28 Feb 2026, 14:02 · Chrome on macOS'))
    + listGroup('Changes', 47, listRow('Updated your profile', '27 Feb 2026, 09:15 · myprofile'))
    + moreRow('22 more in your activity history'),
  ),
  suspiciousSection: attentionPanel('2 things to look at', [
    'Failed sign-in from Berlin on 3 Mar',
    'Two-step verification was turned off',
  ]),
};

/** Every remaining placeholder, in the order the catalogue declares them. */
const PLAIN_VALUES: Record<string, string> = {
  name: 'John Doe',
  username: 'johndoe',
  primaryEmail: 'john@example.com',
  recoveryEmail: 'backup@example.com',

  otp: '482913',
  lifetimeMinutes: '10',
  password: 'correct-horse-battery-staple',

  count: '5',
  reason: 'Possible spam content',

  periodLabel: '19–25 Aug 2026',
  daysSince: '21',

  title: 'Faster exports',
  message: 'We rebuilt the export pipeline — large projects are now 4x quicker.',
  ctaLabel: 'See what changed',
  ctaUrl: `${URL}/changelog/42`,
  actionLabel: 'View account',
  actionUrl: `${URL}/account/security`,
  tipTitle: 'Enable two-step authentication',
  tipBody: 'Add a second step to sign-in and lock out account takeover.',

  statusType: 'suspended for 7 days',
  suspendedUntil: '3 Mar 2026, 09:00 UTC',
  suspendedNextStep: 'You cannot sign in or use Tirbeo services until then',
  dateLabel: '28 Feb 2026',
  exportedAt: '28 Feb 2026, 16:00 UTC',
  changedAt: '28 Feb 2026, 13:58 UTC',

  startTime: '1 Mar 2026, 02:00 UTC',
  estimatedEnd: '1 Mar 2026, 02:30 UTC',
  completedAt: '1 Mar 2026, 02:34 UTC',
  duration: '30 minutes',
  maintenanceTitle: 'Database upgrade',
  maintenanceMessage: 'Brief downtime is expected while we upgrade.',
  completionMessage: 'The upgrade finished and everything is back to normal.',

  ipAddress: '203.0.113.9',
  location: 'Berlin, Germany',
  device: 'Chrome on macOS',
  loginTime: '28 Feb 2026, 14:02 UTC',
  twoFactorUrl: 'https://myprofile.tirbeo.com/settings/two-factor',

  sentFor: 'admin preview',
  subject: 'Unhandled error in export worker',
};

export const SAMPLE_VAR_NAMES = [
  ...Object.keys(SECTION_VALUES),
  ...Object.keys(PLAIN_VALUES),
];

/**
 * A complete set of preview variables.
 *
 * `urls` is injected rather than read from the environment here so this module
 * stays importable from a plain script without pulling in app config.
 */
export function sampleVars(
  urls: { accountsUrl: string; dashboardUrl: string },
): Record<string, string> {
  return {
    ...SECTION_VALUES,
    ...PLAIN_VALUES,
    magicLink: `${urls.accountsUrl}/callback?magic_token=sample-token`,
    resetUrl: `${urls.accountsUrl}/reset?token=sample-token`,
    recoveryUrl: `${urls.accountsUrl}/recover?token=sample-token`,
    accountsUrl: `${urls.accountsUrl}/onboarding`,
    dashboardUrl: urls.dashboardUrl,
  };
}

/**
 * The manifest as this particular mail would actually go out.
 *
 * `sendTemplateEmail` blanks the unsubscribe slot on essential mail; a preview
 * that always filled it showed admins an unsubscribe line their users would
 * never see, and the one thing worth checking about a code email looked wrong.
 */
export function previewVars(
  templateName: string,
  urls: { accountsUrl: string; dashboardUrl: string },
): Record<string, string> {
  const vars = sampleVars(urls);
  if (ESSENTIAL_TEMPLATES.has(templateName)) vars.unsubscribeSection = '';
  return vars;
}
