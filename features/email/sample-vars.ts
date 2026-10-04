/**
 * Sample data for previewing templates without sending one.
 *
 * Exists because the admin preview endpoint and the offline render script both
 * need to fill every placeholder in the catalogue, and each had its own list.
 * The endpoint's list had drifted badly — 12 names no template used, and 60 of
 * the 91 real placeholders missing outright, so most previews on the admin page
 * were showing the literal text `{{submissionId}}` where a value should be.
 * One list, checked by a test, is the only way to keep the preview honest.
 *
 * Real URLs are resolved from the environment at call time so a preview points
 * at whichever deployment is being looked at.
 */

export type SampleVarResolver = () => {
  accountsUrl: string;
  dashboardUrl: string;
  adminUrl: string;
};

/** Plausible values for every section slot the templates expose. */
const SECTION_VALUES: Record<string, string> = {
  unsubscribeSection: '<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#6e6e73"><a href="https://tirbeo.com/u" style="color:#6e6e73;text-decoration:underline;">Unsubscribe from these emails</a></p>',
  digestItems:
    '<div style="padding:14px 16px;background:#18181a;border:1px solid #2a2a2c;border-radius:14px;margin-bottom:8px;"><div style="font-size:14px;font-weight:600;line-height:22px;color:#ffffff;">New submission on Contact Form</div><div style="font-size:13px;line-height:20px;color:#8a8a8e;padding-top:2px;">Someone filled in your contact form.</div></div>',
  activitySection:
    '<div style="padding:14px 16px;background:#18181a;border:1px solid #2a2a2c;border-radius:14px;margin-bottom:8px;"><div style="font-size:14px;font-weight:600;line-height:22px;color:#ffffff;">3 sign-ins this week</div><div style="font-size:13px;line-height:20px;color:#8a8a8e;padding-top:2px;">Last one from Chrome on Linux.</div></div>',
  activitySummary: '<div style="padding:14px 16px;background:#18181a;border:1px solid #2a2a2c;border-radius:14px;margin-bottom:8px;font-size:14px;line-height:22px;color:#ffffff;">You signed in 4 times and created 2 projects this week.</div>',
  details: '<div style="font-size:14px;line-height:22px;color:#ffffff;">Signed in from a device we have not seen before.</div>',
  submissionData:
    '<div style="background:#18181a;border:1px solid #2a2a2c;border-radius:14px;"><div style="padding:12px 16px;border-bottom:1px solid #2a2a2c;"><span style="color:#8a8a8e;font-size:13px;">Name:</span> <span style="color:#ffffff;font-size:14px;">Jane Doe</span></div><div style="padding:12px 16px;border-bottom:1px solid #2a2a2c;"><span style="color:#8a8a8e;font-size:13px;">Email:</span> <span style="color:#ffffff;font-size:14px;">jane@example.com</span></div><div style="padding:12px 16px;"><span style="color:#8a8a8e;font-size:13px;">Plan:</span> <span style="color:#ffffff;font-size:14px;">Pro</span></div></div>',
  answers: '<div style="padding:14px 16px;background:#18181a;border:1px solid #2a2a2c;border-radius:14px;margin-bottom:8px;"><div style="font-size:14px;font-weight:600;line-height:22px;color:#ffffff;">What is your role?</div><div style="font-size:13px;line-height:20px;color:#8a8a8e;padding-top:2px;">Engineer</div></div>',
  fieldRows: '<div style="padding:14px 16px;background:#18181a;border:1px solid #2a2a2c;border-radius:14px;margin-bottom:8px;"><div style="font-size:14px;font-weight:600;line-height:22px;color:#ffffff;">Role</div><div style="font-size:13px;line-height:20px;color:#8a8a8e;padding-top:2px;">Engineer</div></div>',
  fieldsRows:
    '<div style="background:#18181a;border:1px solid #2a2a2c;border-radius:14px;"><div style="padding:12px 16px;border-bottom:1px solid #2a2a2c;"><span style="color:#8a8a8e;font-size:13px;">Name:</span> <span style="color:#ffffff;font-size:14px;">Jane</span></div><div style="padding:12px 16px;"><span style="color:#8a8a8e;font-size:13px;">Team size:</span> <span style="color:#ffffff;font-size:14px;">12</span></div></div>',
  statRows:
    '<div style="background:#18181a;border:1px solid #2a2a2c;border-radius:14px;"><div style="padding:12px 16px;border-bottom:1px solid #2a2a2c;"><span style="color:#8a8a8e;font-size:13px;">Logins:</span> <span style="color:#ffffff;font-size:14px;">12</span></div><div style="padding:12px 16px;"><span style="color:#8a8a8e;font-size:13px;">Submissions:</span> <span style="color:#ffffff;font-size:14px;">47</span></div></div>',
  suspiciousSection:
    '<div style="margin:0 0 20px;"><p style="margin:0 0 6px;font-size:14px;font-weight:600;line-height:22px;color:#ffffff;">New sign-in from Berlin, Germany</p><p style="margin:0;font-size:13px;line-height:20px;color:#8a8a8e;">If this was not you, review your sessions.</p></div>',
};

/** Every remaining placeholder, in the order the catalogue declares them. */
const PLAIN_VALUES: Record<string, string> = {
  name: 'John Doe',
  username: 'johndoe',
  userEmail: 'john@example.com',
  primaryEmail: 'john@example.com',
  recoveryEmail: 'backup@example.com',

  otp: '482913',
  lifetimeMinutes: '10',
  password: 'correct-horse-battery-staple',

  formTitle: 'Customer feedback',
  formUrl: 'https://tirbeo.com/f/contact-form',
  viewUrl: 'https://tirbeo.com/f/contact-form/r/sub_7a3',
  submissionId: 'sub_7a3c9',
  responseId: 'res_7a3c9',
  respondentName: 'Jane Doe',
  submittedAt: '28 Feb 2026, 14:22 UTC',
  flaggedAt: '28 Feb 2026, 14:22 UTC',
  deletedAt: '28 Feb 2026, 15:10 UTC',
  updatedAt: '28 Feb 2026, 16:00 UTC',
  count: '5',
  reason: 'Possible spam content',

  ticketId: 'TKT-001',
  ticketUrl: 'https://myprofile.tirbeo.com/support/tickets/TKT-001',
  ticketSubject: 'Export stuck at 80%',
  ticketStatus: 'Open',
  updateMessage: "We've moved this to the engineering team.",
  replyContent: 'Thanks for the report — we are looking into this now.',
  replierName: 'Tirbeo Support',

  periodLabel: '19–25 Aug 2026',
  daysSince: '21',

  title: 'Faster exports',
  message: 'We rebuilt the export pipeline — large projects are now 4x quicker.',
  ctaLabel: 'See what changed',
  ctaUrl: 'https://tirbeo.com/changelog/42',
  actionLabel: 'View account',
  actionUrl: 'https://myprofile.tirbeo.com/account/security',
  tipTitle: 'Enable two-factor authentication',
  tipBody: 'Add a second step to sign-in and lock out account takeover.',
  statusType: 'Deactivated',
  untilLabel: 'Until further notice',
  dateLabel: '28 Feb 2026',
  exportedAt: '28 Feb 2026, 16:00 UTC',
  changedAt: '28 Feb 2026, 13:58 UTC',
  alertTime: '28 Feb 2026, 12:05 UTC',

  startTime: '1 Mar 2026, 02:00 UTC',
  estimatedEnd: '1 Mar 2026, 02:30 UTC',
  completedAt: '1 Mar 2026, 02:34 UTC',
  duration: '30 minutes',
  maintenanceTitle: 'Database upgrade',
  maintenanceMessage: 'Brief downtime is expected while we upgrade.',
  completionMessage: 'The upgrade finished and everything is back to normal.',

  ip: '203.0.113.9',
  ipAddress: '203.0.113.9',
  location: 'Berlin, Germany',
  device: 'Chrome on macOS',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  loginTime: '28 Feb 2026, 14:02 UTC',
  twoFactorUrl: 'https://myprofile.tirbeo.com/settings/two-factor',

  service: 'api',
  severity: 'high',
  errorType: 'TypeError',
  stack: 'at exportWorker (app.js:42:9)',
  source: 'auth.middleware',
  url: 'https://tirbeo.com/errors/err_1a2b',

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
  urls: { accountsUrl: string; dashboardUrl: string; adminUrl: string },
): Record<string, string> {
  return {
    ...SECTION_VALUES,
    ...PLAIN_VALUES,
    magicLink: `${urls.accountsUrl}/callback?magic_token=sample-token`,
    resetUrl: `${urls.accountsUrl}/reset?token=sample-token`,
    recoveryUrl: `${urls.accountsUrl}/recover?token=sample-token`,
    accountsUrl: `${urls.accountsUrl}/onboarding`,
    dashboardUrl: urls.dashboardUrl,
    adminUrl: urls.adminUrl,
  };
}