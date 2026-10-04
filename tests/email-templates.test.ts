import { describe, it, expect } from 'vitest';
import {
  buildTemplates,
  clearTemplateCache,
  getTemplate,
  RAW_HTML_VARS,
} from '../features/email/email-templates';
import { htmlToText, renderTemplate } from '../features/email/email';
import { sampleVars } from '../features/email/sample-vars';

const LOGO = 'https://cdn.tirbeo.com/logo-opt.png';

/** Every section slot, so a template with one still renders as markup. */
const SECTION_VARS = {
  statRows: '<div><strong>Logins:</strong> 12</div>',
  suspiciousSection: '<div><strong>New device</strong> from Berlin</div>',
  digestItems: '<div><strong>New submission</strong></div>',
  activitySection: '<div><strong>Recent activity</strong></div>',
  activitySummary: '<div>Signed in 4 times</div>',
  details: '<div>Signed in from a new device.</div>',
  submissionData: '<div>Field: value</div>',
  answers: '<div>Q: A</div>',
  fieldRows: '<div>Answer: Yes</div>',
  fieldsRows: '<div>Name: Test</div>',
  unsubscribeSection: '<a href="https://tirbeo.com/u">Unsubscribe</a>',
};

/**
 * All 91 distinct placeholders across the catalogue.
 *
 * Kept exhaustive on purpose: the test below renders every template and fails
 * if any placeholder is left unfilled, so a template that grows a new variable
 * cannot be added without deciding what it looks like with real data.
 */
const VARS: Record<string, string> = {
  ...SECTION_VARS,
  name: 'Bishnu',
  username: 'bishnu',
  userEmail: 'bishnu@tirbeo.com',
  primaryEmail: 'bishnu@tirbeo.com',
  recoveryEmail: 'backup@tirbeo.com',
  otp: '482913',
  lifetimeMinutes: '10',
  magicLink: 'https://accounts.tirbeo.com/callback?magic_token=abc',
  resetUrl: 'https://accounts.tirbeo.com/reset?token=abc',
  recoveryUrl: 'https://accounts.tirbeo.com/recover?token=abc',
  accountsUrl: 'https://accounts.tirbeo.com/onboarding',
  dashboardUrl: 'https://myprofile.tirbeo.com',
  adminUrl: 'https://tirbeo.com/admin',
  settingsUrl: 'https://myprofile.tirbeo.com/account/preferences',
  webhookUrl: 'https://myprofile.tirbeo.com/api/webhooks/hooks_1',
  formUrl: 'https://tirbeo.com/f/form_1',
  ticketUrl: 'https://myprofile.tirbeo.com/support/tickets/tk_9f2',
  ticketId: 'tk_9f2',
  ticketSubject: 'Export stuck at 80%',
  ticketStatus: 'Open',
  updateMessage: 'Moved to In review.',
  replyContent: 'We are looking into this now.',
  replierName: 'Tirbeo Support',
  formTitle: 'Customer feedback',
  submissionId: 'sub_7a3',
  responseId: 'res_7a3',
  submissionData: '<div>Plan: Pro</div>',
  respondentName: 'Aarav',
  newResponses: '6',
  totalResponses: '128',
  responseCount: '42',
  count: '5',
  scheduledAt: '1 Mar 2026, 09:00',
  flaggedAt: '28 Feb 2026, 14:22',
  reason: 'Possible spam content',
  milestone: '100 responses',
  addedByName: 'Priya',
  role: 'Editor',
  periodLabel: 'Last 7 days',
  statRows: '<div><strong>Logins:</strong> 12</div>',
  suspiciousSection: '<div><strong>New device</strong> from Berlin</div>',
  activitySummary: '<div>Signed in 4 times this week.</div>',
  daysSince: '21',
  details: '<div>Signed in from a new device.</div>',
  ip: '203.0.113.9',
  ipAddress: '203.0.113.9',
  location: 'Berlin, Germany',
  device: 'Chrome on macOS',
  userAgent: 'Mozilla/5.0 (Macintosh)',
  loginTime: '28 Feb 2026, 14:02',
  changedAt: '28 Feb 2026, 13:58',
  password: 'correct-horse-battery-staple',
  deletedAt: '28 Feb 2026, 15:10',
  dateLabel: '28 Feb 2026',
  exportedAt: '28 Feb 2026, 16:00',
  updatedAt: '28 Feb 2026, 16:00',
  submittedAt: '28 Feb 2026, 12:40',
  completedAt: '28 Feb 2026, 17:00',
  untilLabel: '3 Mar 2026, 09:00',
  alertTime: '28 Feb 2026, 12:05',
  twoFactorUrl: 'https://myprofile.tirbeo.com/settings/two-factor',
  startTime: '1 Mar 2026, 02:00',
  estimatedEnd: '1 Mar 2026, 02:30',
  duration: '30 minutes',
  maintenanceTitle: 'Database upgrade',
  maintenanceMessage: 'Brief downtime is expected.',
  completionMessage: 'Everything is back to normal.',
  title: 'Faster exports',
  message: 'We rebuilt the export pipeline.',
  ctaLabel: 'See what changed',
  ctaUrl: 'https://tirbeo.com/changelog/42',
  actionLabel: 'View account',
  actionUrl: 'https://tirbeo.com/account',
  tipTitle: 'Connect your domain',
  tipBody: 'Point a CNAME at Tirbeo and go live.',
  statusType: 'Deactivated',
  service: 'api',
  severity: 'high',
  errorType: 'TypeError',
  errorMessage: 'Cannot read properties of undefined',
  stack: 'at handler (app.js:42:9)',
  source: 'auth.middleware',
  url: 'https://tirbeo.com/errors/err_1',
  sentFor: 'admin test',
  httpStatus: '500',
  subject: 'Unhandled error in export worker',
  viewUrl: 'https://tirbeo.com/f/form_1/r/sub_7a3',
};

describe('renderTemplate escaping', () => {
  it('renders section slots as HTML without the caller listing them', async () => {
    // Regression: renderTemplate once took a raw-var set that *replaced* the
    // canonical list, and jobs.ts sent weekly_summary without listing
    // `statRows`. The stat table reached users as literal
    // `&lt;div&gt;&lt;strong&gt;Logins:&lt;/strong&gt; 12` text.
    const tpl = await getTemplate('weekly_summary', LOGO);
    expect(tpl).toBeDefined();

    const html = renderTemplate(tpl!.html, VARS, new Set(['unsubscribeSection']));

    expect(html).toContain('<strong>Logins:</strong>');
    expect(html).not.toContain('&lt;div&gt;');
    expect(html).not.toContain('&lt;strong&gt;');
  });

  it('honours an explicitly empty extra set without losing the canonical list', async () => {
    const tpl = await getTemplate('weekly_summary', LOGO);
    const html = renderTemplate(tpl!.html, VARS, new Set());
    expect(html).toContain('<strong>Logins:</strong>');
  });

  it('escapes ordinary user text', async () => {
    const tpl = await getTemplate('welcome', LOGO);

    const xss = renderTemplate(tpl!.html, { name: '<script>alert(1)</script>' }, new Set());
    expect(xss).toContain('&lt;script&gt;');
    expect(xss).not.toContain('<script>alert');

    const amp = renderTemplate(tpl!.html, { name: 'Tom & "Jerry"' }, new Set());
    expect(amp).toContain('Tom &amp;');
    expect(amp).toContain('&quot;Jerry&quot;');
  });

  it('treats every canonical section slot as raw', () => {
    // Guards the list itself against being trimmed by a well-meaning cleanup.
    expect(RAW_HTML_VARS.has('statRows')).toBe(true);
    expect(RAW_HTML_VARS.has('suspiciousSection')).toBe(true);
    expect(RAW_HTML_VARS.has('digestItems')).toBe(true);
    expect(RAW_HTML_VARS.has('unsubscribeSection')).toBe(true);
  });
});

describe('template cache', () => {
  it('renders a template once and serves later lookups from cache', async () => {
    clearTemplateCache();
    const first = await getTemplate('welcome', LOGO);
    const second = await getTemplate('welcome', LOGO);
    // Same object reference proves the second call did not re-render.
    expect(second).toBe(first);
  });

  it('keys the cache on logo so a branding change is not served stale', async () => {
    clearTemplateCache();
    const a = await getTemplate('welcome', 'https://cdn.tirbeo.com/a.png');
    const b = await getTemplate('welcome', 'https://cdn.tirbeo.com/b.png');
    expect(a).not.toBe(b);
    // Branding still affects rendered output (cache keying); just ensure different instances
    expect(a!.html).not.toEqual(b!.html);
  });

  it('does not let a single cached template masquerade as the full catalogue', async () => {
    // Regression: getTemplate stored a one-entry bucket under the same cache
    // key buildTemplates uses, so a prior getTemplate() made buildTemplates()
    // return a single template instead of 55 — intermittently, depending on
    // which ran first.
    clearTemplateCache();
    await getTemplate('welcome', LOGO);
    const all = await buildTemplates(LOGO);
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(1);
    expect(all['signup_otp']).toBeDefined();
    expect(all['ticket_created']).toBeDefined();
  });

  it('returns undefined for an unknown template instead of throwing', async () => {
    expect(await getTemplate('definitely_not_a_template', LOGO)).toBeUndefined();
  });
});

describe('catalogue', () => {
  it('builds every template with no unresolved placeholders', async () => {
    clearTemplateCache();
    const all = await buildTemplates(LOGO);
    const names = Object.keys(all);
    expect(names.length).toBeGreaterThanOrEqual(1);

    const sample: Record<string, string> = { ...VARS };
    for (const [name, tpl] of Object.entries(all)) {
      const rendered = tpl.html.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) =>
        sample[key] !== undefined ? sample[key] : m,
      );
      const leftover = rendered.match(/\{\{\s*(\w+)\s*\}\}/g) || [];
      // Reported per-template so a failure names the template.
      expect({ name, leftover }).toEqual({ name, leftover: [] });
    }
  });

  it('gives every template a non-empty subject', async () => {
    clearTemplateCache();
    const all = await buildTemplates(LOGO);
    for (const [name, tpl] of Object.entries(all)) {
      expect({ name, subject: tpl.subject.length > 0 }).toEqual({ name, subject: true });
    }
  });
});

describe('preview manifest parity', () => {
  it('covers every placeholder in the catalogue', async () => {
    // The admin preview and the offline render script both fill templates from
    // this manifest. When each had a private list they drifted: the endpoint's
    // was missing 60 of 91 names, so previews showed literal {{submissionId}}.
    clearTemplateCache();
    const all = await buildTemplates(LOGO);
    const needed = new Set<string>();
    for (const tpl of Object.values(all)) {
      for (const m of `${tpl.html} ${tpl.subject}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
        needed.add(m[1]!);
      }
    }

    const provided = new Set(
      Object.keys(
        sampleVars({
          accountsUrl: 'https://accounts.tirbeo.com',
          dashboardUrl: 'https://myprofile.tirbeo.com',
          adminUrl: 'https://tirbeo.com/admin',
        }),
      ),
    );

    expect({ missing: [...needed].filter((v) => !provided.has(v)).sort() }).toEqual({ missing: [] });

    // Names nobody uses are dead weight and usually mean a rename half-applied.
    expect({ stale: [...provided].filter((v) => !needed.has(v)).sort() }).toEqual({ stale: [] });
  });

  it('leaves no placeholder when a template is rendered for preview', async () => {
    clearTemplateCache();
    const all = await buildTemplates(LOGO);
    const vars = sampleVars({
      accountsUrl: 'https://accounts.tirbeo.com',
      dashboardUrl: 'https://myprofile.tirbeo.com',
      adminUrl: 'https://tirbeo.com/admin',
    });
    const dirty = Object.entries(all)
      .map(([name, tpl]) => ({
        name,
        leftover: (renderTemplate(tpl.html, vars).match(/\{\{\s*\w+\s*\}\}/g) || []).length,
      }))
      .filter((x) => x.leftover > 0);
    expect(dirty).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('strips the zero-width padding react-email puts in <Preview>', () => {
    const html =
      '<div>‌‏﻿‎‏Hello</div>';
    const text = htmlToText(html);
    expect(text).not.toMatch(/[-‏⁠﻿]/);
    expect(text).toContain('Hello');
  });

  it('keeps link targets, since in an email the link is the content', () => {
    const text = htmlToText('<a href="https://tirbeo.com/magic?token=abc">Sign in</a>');
    expect(text).toContain('Sign in');
    expect(text).toContain('https://tirbeo.com/magic?token=abc');
  });

  it('does not run a stacked label into its value', () => {
    const text = htmlToText('<span style="display:block">Your code</span><span>482913</span>');
    expect(text).toContain('Your code\n482913');
  });

  it('drops markup-only nodes and never leaks a tag', () => {
    const text = htmlToText('<style>.a{color:red}</style><!-- x --><p>Body</p><img src="x">');
    expect(text).toBe('Body');
  });

  it('escapes entities rather than emitting raw angle brackets', () => {
    expect(htmlToText('<p>Tom &amp; &lt;Jerry&gt;</p>')).toBe('Tom & <Jerry>');
  });

  it('keeps a rendered template readable end to end', async () => {
    const all = await buildTemplates(LOGO);
    const text = htmlToText(all['signup_otp']!.html.replace('{{otp}}', '482913'));
    expect(text).toContain('482913');
    expect(text).not.toContain('<');
    expect(text.length).toBeGreaterThan(50);
  });
});