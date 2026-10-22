import { EMAIL_TEMPLATES } from '@/features/email/email-templates';
import { htmlToText } from '@/features/email/email';
let max = 0, who = '';
for (const [name, fn] of Object.entries(EMAIL_TEMPLATES)) {
  const { html } = fn('x', name);
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > max) { max = bytes; who = name; }
}
console.log('largest html:', who, max, 'bytes');
const w = EMAIL_TEMPLATES.welcome('x', 'welcome').html;
console.log('welcome html bytes:', Buffer.byteLength(w), 'text bytes:', Buffer.byteLength(htmlToText(w)));
