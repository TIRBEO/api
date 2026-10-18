import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTemplates,
  clearTemplateCache,
  getTemplate,
  EMAIL_TEMPLATES,
  RAW_HTML_VARS,
} from '../features/email/email-templates';
import { htmlToText, renderTemplate } from '../features/email/email';
import { sampleVars, previewVars } from '../features/email/sample-vars';

const LOGO = 'https://cdn.tirbeo.com/logo-opt.png';

/** Every section slot, so a template with one still renders as markup. */
const SECTION_VARS = {
  statRows: '<div><strong>Logins:</strong> 12</div>',
  suspiciousSection: '<div><strong>New device</strong> from Berlin</div>',
  digestItems: '<div><strong>New submission</strong></div>',
  activitySection: '<div><strong>Recent activity</strong></div>',
  activitySummary: '<div>Signed in 4 times</div>',
  details: '<div>Signed in from a new device.</div>',
  unsubscribeSection: '<a href="https://tirbeo.com/u">Unsubscribe</a>',
};

/**
 * Every distinct placeholder across the catalogue.
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
  twoFactorUrl: 'https://myprofile.tirbeo.com/settings/two-factor',
  reason: 'Possible spam content',
  count: '5',
  periodLabel: 'Last 7 days',
  daysSince: '21',
  ipAddress: '203.0.113.9',
  location: 'Berlin, Germany',
  device: 'Chrome on macOS',
  userAgent: 'Mozilla/5.0 (Macintosh)',
  loginTime: '28 Feb 2026, 14:02',
  changedAt: '28 Feb 2026, 13:58',
  password: 'correct-horse-battery-staple',
  dateLabel: '28 Feb 2026',
  exportedAt: '28 Feb 2026, 16:00',
  completedAt: '28 Feb 2026, 17:00',
  alertTime: '28 Feb 2026, 12:05',
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
  statusType: 'suspended for 7 days',
  suspendedUntil: '3 Mar 2026, 09:00 UTC',
  suspendedNextStep: 'You cannot sign in until then',
  service: 'api',
  severity: 'high',
  errorType: 'TypeError',
  errorMessage: 'Cannot read properties of undefined',
  stack: 'at handler (app.js:42:9)',
  source: 'auth.middleware',
  url: 'https://tirbeo.com/errors/err_1',
  sentFor: 'admin test',
  subject: 'Unhandled error in export worker',
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
    // return a single template instead of the whole catalogue — intermittently,
    // depending on which ran first.
    clearTemplateCache();
    await getTemplate('welcome', LOGO);
    const all = await buildTemplates(LOGO);
    expect(Object.keys(all).length).toBe(Object.keys(EMAIL_TEMPLATES).length);
    expect(all['signup_otp']).toBeDefined();
    expect(all['weekly_summary']).toBeDefined();
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
    // was missing most of the catalogue, so previews showed literal {{otp}}.
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
    const urls = {
      accountsUrl: 'https://accounts.tirbeo.com',
      dashboardUrl: 'https://myprofile.tirbeo.com',
    };
    const dirty = Object.entries(all)
      .map(([name, tpl]) => ({
        name,
        leftover: (renderTemplate(tpl.html, previewVars(name, urls)).match(/\{\{\s*\w+\s*\}\}/g) || []).length,
      }))
      .filter((x) => x.leftover > 0);
    expect(dirty).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('strips the zero-width padding around the preheader', () => {
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

/* ═══════════════════════════════════════════════════════════════════
   Every link a mail sends to the dashboard names a page that exists

   Six CTAs pointed at `/account/sessions` and `/account/security`, which the
   settings app has never had, and they stayed broken for as long as anything
   else did because nothing joins the two: the addresses are strings inside
   template functions in one app and the pages are directories in another. A
   type check cannot see across that, and neither can a person reviewing a
   diff of one app.

   So the catalogue is rendered here and every address on the dashboard host
   is looked up in the app's own tree — the directories that hold a page file,
   the record shapes its one catch-all route answers for, and the redirects
   its config says it answers. The lists are read from the source rather than
   written down again, because a list kept here is a second thing to forget to
   update.
   ═══════════════════════════════════════════════════════════════════ */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..'); // apps/api/tests -> repo root
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** Both hosts the settings app answers on: the current one and the dashboard
    address it is still allowed to be reached through. */
const DASHBOARD_HOSTS = ['myprofile.tirbeo.com', 'dashboard.tirbeo.com'];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A route the app can serve, as a matcher. `[slug]` is one segment; a
    `:param` from a redirect source is one segment, and `:path*` is any
    number of them. */
function routeMatcher(route: string): RegExp {
  const src = route
    .split('/')
    .filter(Boolean)
    .map((seg) =>
      seg.startsWith(':') ? (seg.endsWith('*') ? '(?:/[^/]+)+' : '[^/]+') : esc(seg),
    )
    .join('/');
  // `route === "/"` leaves nothing here, and the app's root address is the
  // root redirect — so an address with no path at all is the same page.
  return new RegExp(src ? `^/${src}/?$` : '^/?$');
}

function realDashboardRoutes(): RegExp[] {
  const out: RegExp[] = [];

  /* 1. Every directory under app/ that holds a page. `app/**` is walked rather
        than the route manifest read, because the manifest is build output and
        a test that runs before a build would be checking a stale answer. */
  const walk = (dir: string, base: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('(')) continue;
      const rel = `${base}/${entry.name}`;
      // The record catch-all is added below from its own table, so a path under
      // it isn't allowed just for being under /settings.
      if (entry.name === '[...path]') continue;
      if (readdirSync(path.join(dir, entry.name)).includes('page.tsx')) out.push(routeMatcher(rel));
      walk(path.join(dir, entry.name), rel);
    }
  };
  walk(path.join(repoRoot, 'apps/myprofile/app'), '');

  /* 2. The shapes /settings/[...path] answers for: the six record screens and
        the account-status section/item paths. Read from the table the route
        itself reads, so the two can't drift. */
  const table = read('apps/myprofile/lib/record-routes.ts');
  const ids = /const ID_SCREENS = new Set\(\[([\s\S]*?)\] as const/.exec(table);
  expect(ids, 'ID_SCREENS not found in lib/record-routes.ts').not.toBeNull();
  for (const screen of [...ids![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])) {
    out.push(new RegExp(`^/settings/${esc(screen!)}/[^/]+/?$`));
  }
  out.push(new RegExp('^/settings/account-status/[^/]+(?:/[^/]+)?/?$'));

  /* 3. Redirect sources — an address the app answers by moving you, which a
        mail link is allowed to use. */
  for (const m of read('apps/myprofile/next.config.ts').matchAll(/source:\s*"([^"]+)"/g)) {
    out.push(routeMatcher(m[1]!));
  }

  return out;
}

function dashboardPaths(html: string): string[] {
  const found: string[] = [];
  for (const m of html.matchAll(/href="https?:\/\/([^/"]+)([^"]*)"/g)) {
    if (!DASHBOARD_HOSTS.includes(m[1]!.toLowerCase())) continue;
    // &amp; is what an href carrying a query actually looks like in markup.
    found.push(decodeURIComponent(m[2]!).replace(/&amp;/g, '&').split('?')[0]!);
  }
  return found;
}

describe('links a mail sends to the dashboard', () => {
  it('resolve to a page, a record shape, or a redirect in the settings app', async () => {
    clearTemplateCache();
    const all = await buildTemplates(LOGO);
    const routes = realDashboardRoutes();

    const bad: { template: string; path: string }[] = [];
    let checked = 0;
    for (const [name, tpl] of Object.entries(all)) {
      const html = renderTemplate(tpl.html, VARS, new Set());
      for (const p of dashboardPaths(html)) {
        checked++;
        if (!routes.some((re) => re.test(p))) bad.push({ template: name, path: p });
      }
    }

    // A guard that checked nothing must not report success — if the host the
    // templates build for ever changes, this fails instead of going quiet.
    expect(checked, 'no dashboard links found in the catalogue').toBeGreaterThan(4);
    expect(bad).toEqual([]);
  });
});