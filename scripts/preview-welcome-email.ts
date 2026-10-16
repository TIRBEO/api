import fs from 'node:fs';
import { getTemplate, renderTemplate } from '@/features/email/email-templates';
import { unsubscribeSection } from '@/features/email/email-fragments';

const tpl = getTemplate('welcome', '')!;
const html = renderTemplate(tpl.html, {
  name: 'Bishnu Neupane',
  unsubscribeSection: unsubscribeSection('https://tirbeo.com/unsubscribe'),
});

const out = new URL('../../welcome-email-preview.html', import.meta.url);
fs.writeFileSync(out, html);
console.log('SUBJECT:', tpl.subject);
console.log('WROTE:', out.pathname);
