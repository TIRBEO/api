/* Timing for the template render cache. Exists because the number it reports
   is the whole justification for the cache: `npx tsx scripts/bench-templates.ts` */
import { clearTemplateCache, getTemplate } from '../features/email/email-templates';

async function main() {
  const LOGO = 'https://cdn.tirbeo.com/logo.png';

  clearTemplateCache();
  let t = Date.now();
  await getTemplate('welcome', LOGO);
  const cold = Date.now() - t;

  t = Date.now();
  for (let i = 0; i < 50; i++) await getTemplate('welcome', LOGO);
  const warm = Date.now() - t;

  clearTemplateCache();
  t = Date.now();
  await getTemplate('welcome', LOGO);
  await getTemplate('magic_link', LOGO);
  await getTemplate('login_otp', LOGO);
  await getTemplate('ticket_replied', LOGO);
  await getTemplate('notification_digest', LOGO);
  const five = Date.now() - t;

  console.log('cold, 1 template      :', cold + 'ms');
  console.log('warm, 50 lookups      :', warm + 'ms  (' + (warm / 50).toFixed(2) + 'ms each)');
  console.log('cold, 5 distinct      :', five + 'ms  (avg ' + (five / 5).toFixed(1) + 'ms)');
  console.log('previous behaviour    : all 55 templates rebuilt on every send (~220ms)');
}

main().catch((e) => { console.error(e); process.exit(1); });
