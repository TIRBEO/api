/**
 * Render every email template and fail the build if one cannot be built.
 *
 * A template is code that nobody looks at until an email fails to arrive, and
 * the failure surfaces as a 500 in a route nobody was testing at the time.
 * `tsc` cannot see that: a template that throws only shows up when something
 * actually builds it.
 *
 * So this does the one thing a type checker cannot: build every template, in
 * the same way `sendEmail` will, and complain if one throws, comes back empty,
 * or still carries a placeholder after a render.
 *
 *   npx tsx scripts/check-email-templates.ts
 */

import {
  buildTemplates,
  renderTemplate,
  EMAIL_TEMPLATES } from '../features/email/email-templates';

const LOGO =
  'data:image/svg+xml;utf8,' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><rect width="120" height="32" fill="%23008080"/></svg>';

/**
 * Fill whatever the template declares, so a new placeholder can be added
 * without editing this file. Note what this does and does not prove: because
 * the values are derived from the template's own placeholders, a variable that
 * is misspelled still gets filled and will not be reported. What is caught
 * here is a template that cannot be built or rendered at all — which is the
 * failure that answers 500 from a route nobody was looking at.
 */
function varsFor(html: string): Record<string, string> {
  const found = html.match(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g) ?? [];
  const names = [...new Set(found.map((m) => m.replace(/[{}\s]/g, '')))];
  const out: Record<string, string> = {};
  for (const name of names) {
    out[name] = name === 'otp' || name === 'code' ? '834219' : `sample-${name}`;
  }
  return out;
}

const problems: string[] = [];

async function check(
  name: string,
  build: () => { subject: string; html: string } | Promise<{ subject: string; html: string }>,
) {
  let built: { subject: string; html: string };
  try {
    built = await build();
  } catch (err) {
    problems.push(`${name}: threw while building — ${(err as Error)?.message || err}`);
    return;
  }
  if (!built || typeof built.html !== 'string' || built.html.length === 0) {
    problems.push(`${name}: built with no html`);
    return;
  }
  if (!built.subject) problems.push(`${name}: built with no subject`);

  let rendered: string;
  try {
    rendered = renderTemplate(built.html, varsFor(built.html));
  } catch (err) {
    problems.push(`${name}: threw while rendering — ${(err as Error)?.message || err}`);
    return;
  }
  const left = rendered.match(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g);
  if (left) {
    problems.push(`${name}: ${[...new Set(left)].slice(0, 3).join(', ')} left unsubstituted`);
  }
  if (/<a[^>]*href="undefined"|background\(undefined\)/.test(rendered)) {
    problems.push(`${name}: rendered an undefined value into the markup`);
  }
}

(async () => {
  const names = Object.keys(EMAIL_TEMPLATES);
  if (names.length === 0) problems.push('no templates are registered');

  /* First, the path sendEmail actually takes: build them all at once, the way
     a real send does. Then go template by template, so a failure names itself
     instead of taking the rest of the report down with it. */
  try {
    await buildTemplates(LOGO);
  } catch (err) {
    problems.push(`buildTemplates threw: ${(err as Error)?.message || err}`);
  }

  for (const name of names) {
    await check(`EMAIL_TEMPLATES.${name}`, () => EMAIL_TEMPLATES[name](LOGO, name));
  }

  if (problems.length) {
    console.error(`\n✗ ${problems.length} email template problem(s):\n`);
    for (const p of problems) console.error(`   ${p}`);
    console.error('');
    process.exit(1);
  }
  console.log(`✓ ${names.length} email templates build and render`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});