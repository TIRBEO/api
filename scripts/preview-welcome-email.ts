import fs from 'node:fs';
import { EMAIL_TEMPLATES, renderTemplate } from '@/features/email/email-templates';

async function main() {
  const t = await EMAIL_TEMPLATES.welcome('');
  const html = renderTemplate(t.html, {
    name: 'Bishnu Neupane',
    unsubscribeSection:
      '<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#6e6e73">You are receiving this email because you created a Tirbeo account. <a href="https://tirbeo.com/unsubscribe" style="color:#6e6e73;text-decoration:underline;">Unsubscribe</a></p>',
  });
  const out = new URL('../../welcome-email-preview.html', import.meta.url);
  fs.writeFileSync(out, html);
  console.log('SUBJECT:', t.subject);
  console.log('WROTE:', out.pathname);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
