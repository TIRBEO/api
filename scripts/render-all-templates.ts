/* Renders every built-in template to disk with sample variables substituted.
   Used to eyeball the whole catalogue after a design change:
     npx tsx scripts/render-all-templates.ts [outDir] [slugs...] */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildTemplates, renderTemplate } from '../features/email/email-templates';
import { previewVars } from '../features/email/sample-vars';

const URLS = {
  accountsUrl: 'https://accounts.tirbeo.com',
  dashboardUrl: 'https://myprofile.tirbeo.com',
};

async function main() {
  const outDir = process.argv[2] || '/tmp/opencode/emails';
  const only = process.argv.slice(3);
  await mkdir(outDir, { recursive: true });

  const t0 = Date.now();
  const all = await buildTemplates();
  const buildMs = Date.now() - t0;

  const names = Object.keys(all).sort();
  const targets = only.length ? names.filter(n => only.includes(n)) : names;

  for (const name of targets) {
    const t = all[name];
    const html = renderTemplate(t.html, previewVars(name, URLS));
    await writeFile(path.join(outDir, `${name}.html`), html, 'utf8');
  }
  console.log(`buildTemplates(): ${buildMs}ms for ${names.length} templates`);
  console.log(`wrote ${targets.length} file(s) to ${outDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
