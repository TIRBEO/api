import { sendEmail } from '../lib/email';

async function testEmail() {
  const testTo = process.argv[2];
  if (!testTo) {
    console.error('Usage: npx tsx scripts/test-email.ts <email@example.com>');
    process.exit(1);
  }

  console.log(`Sending test email to ${testTo}...`);
  const result = await sendEmail(testTo, 'Tirbeo Email Test', `
    <h2>Email delivery test</h2>
    <p>If you received this, Resend email is working.</p>
    <p>Sent at: ${new Date().toISOString()}</p>
  `);

  if (result.success) {
    console.log(`SUCCESS — messageId: ${result.messageId}`);
  } else {
    console.error(`FAILED — ${result.error}`);
  }
}

testEmail();
