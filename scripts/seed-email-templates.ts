import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { buildTemplates } from '../lib/email-templates';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL }) });

const LABELS: Record<string, string> = {
  signup_otp: 'Signup OTP',
  login_otp: 'Login OTP',
  welcome: 'Welcome',
  password_reset_otp: 'Password Reset OTP',
  password_reset_link: 'Password Reset Link',
  verify_email: 'Verify Email',
  magic_link: 'Magic Link',
  password_changed: 'Password Changed',
  suspicious_login: 'Suspicious Login',
  login_alert: 'Login Alert',
  admin_alert: 'Admin Alert',
  system_alert: 'System Alert',
  form_submission_confirmation: 'Form Submission Confirmation',
  form_response: 'Form Response',
  form_notification: 'Form Notification',
  form_flagged: 'Form Flagged',
};

async function main() {
  console.log('Seeding email templates...');
  const templates = buildTemplates('');
  let created = 0;
  let updated = 0;
  for (const [name, tpl] of Object.entries(templates)) {
    if (!LABELS[name]) continue; // skip invoice/billing leftovers
    const existing = await prisma.emailTemplate.findUnique({ where: { name } });
    if (existing) {
      await prisma.emailTemplate.update({
        where: { name },
        data: { subject: tpl.subject, htmlBody: tpl.html, label: LABELS[name] },
      });
      updated++;
    } else {
      await prisma.emailTemplate.create({
        data: { name, label: LABELS[name], subject: tpl.subject, htmlBody: tpl.html },
      });
      created++;
    }
  }
  console.log(`Email templates: ${created} created, ${updated} updated.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
