/* Renders every built-in template to disk with sample variables substituted.
   Used to eyeball the whole catalogue after a design change:
     npx tsx scripts/render-all-templates.ts [outDir] [slugs...] */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildTemplates, renderTemplate } from '../features/email/email-templates';
import { sampleVars } from '../features/email/sample-vars';

// The sample data is the same manifest the admin preview endpoint renders with,
// so what gets eyeballed offline is what the admin sees. It used to be a third
// private copy, which is how the three drifted apart.
const SAMPLE = sampleVars({
  accountsUrl: 'https://accounts.tirbeo.com',
  dashboardUrl: 'https://dashboard.tirbeo.com',
  adminUrl: 'https://tirbeo.com/admin',
});

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
    const vars = { ...SAMPLE, unsubscribeSection: '<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#6e6e73"><a href="#" style="color:#6e6e73;text-decoration:underline;">Unsubscribe from these emails</a></p>' };
    const html = renderTemplate(t.html, vars);
    await writeFile(path.join(outDir, `${name}.html`), html, 'utf8');
  }
  console.log(`buildTemplates(): ${buildMs}ms for ${names.length} templates`);
  console.log(`wrote ${targets.length} file(s) to ${outDir}`);
  const missing = Object.keys(SAMPLE).filter(k => false);
  void missing;
}

main().catch(e => { console.error(e); process.exit(1); });
