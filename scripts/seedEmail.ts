import { prisma } from '../lib/db/prisma';

async function main() {
  console.log('Seeding email configuration...');

  const existing = await prisma.emailConfig.findFirst();
  if (!existing) {
    await prisma.emailConfig.create({
      data: {
        provider: 'resend',
        apiKey: process.env.RESEND_API_KEY || '',
        fromEmail: 'noreply@tirbeo.app',
        fromName: 'Tirbeo',
        enabled: true,
      },
    });
    console.log('  ✓ EmailConfig created (resend)');
  } else {
    console.log('  - EmailConfig already exists, skipping');
  }

  console.log('Seeding email templates...');

  const templates = [
    {
      name: 'signup_otp',
      label: 'Signup OTP',
      subject: 'Your Tirbeo verification code',
      variables: JSON.stringify([{ name: 'otp', label: 'OTP Code', defaultValue: '123456' }]),
      htmlBody: `<div style="background:#0B0B0D;color:#F2EEE8;font-family:Inter,system-ui,sans-serif;padding:48px 24px;text-align:center;max-width:480px;margin:0 auto;border-radius:16px">
  <div style="font-size:13px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:#7B7E84;margin-bottom:32px">Tirbeo</div>
  <p style="color:#A6A6A6;font-size:14px;margin:0 0 8px">Your verification code</p>
  <div style="font-size:48px;font-weight:700;letter-spacing:8px;margin:20px 0;color:#F2EEE8;background:rgba(255,255,255,0.06);padding:16px 24px;border-radius:12px;display:inline-block;border:1px solid rgba(255,255,255,0.08)">{{otp}}</div>
  <p style="color:#7B7E84;font-size:13px;margin:28px 0 0">This code expires in 10 minutes.</p>
  <p style="color:#7B7E84;font-size:12px;margin:16px 0 0">If you didn't request this, you can safely ignore this email.</p>
</div>`,
    },
    {
      name: 'login_otp',
      label: 'Login OTP',
      subject: 'Your Tirbeo login code',
      variables: JSON.stringify([{ name: 'otp', label: 'OTP Code', defaultValue: '123456' }]),
      htmlBody: `<div style="background:#0B0B0D;color:#F2EEE8;font-family:Inter,system-ui,sans-serif;padding:48px 24px;text-align:center;max-width:480px;margin:0 auto;border-radius:16px">
  <div style="font-size:13px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:#7B7E84;margin-bottom:32px">Tirbeo</div>
  <p style="color:#A6A6A6;font-size:14px;margin:0 0 8px">Your login code</p>
  <div style="font-size:48px;font-weight:700;letter-spacing:8px;margin:20px 0;color:#F2EEE8;background:rgba(255,255,255,0.06);padding:16px 24px;border-radius:12px;display:inline-block;border:1px solid rgba(255,255,255,0.08)">{{otp}}</div>
  <p style="color:#7B7E84;font-size:13px;margin:28px 0 0">This code expires in 10 minutes.</p>
  <p style="color:#7B7E84;font-size:12px;margin:16px 0 0">If you didn't request this, you can safely ignore this email.</p>
</div>`,
    },
    {
      name: 'welcome',
      label: 'Welcome Email',
      subject: 'Welcome to Tirbeo',
      variables: JSON.stringify([{ name: 'name', label: 'User Name', defaultValue: 'there' }]),
      htmlBody: `<div style="background:#0B0B0D;color:#F2EEE8;font-family:Inter,system-ui,sans-serif;padding:48px 24px;text-align:center;max-width:480px;margin:0 auto;border-radius:16px">
  <div style="font-size:13px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:#7B7E84;margin-bottom:32px">Tirbeo</div>
  <h1 style="font-size:24px;font-weight:700;margin:0 0 16px;color:#F2EEE8">Welcome aboard!</h1>
  <p style="color:#A6A6A6;font-size:14px;margin:0 0 24px">Hi {{name}}, your account has been created. Start exploring Tirbeo today.</p>
  <a href="https://dashboard.tirbeo.app" style="display:inline-block;background:#D8B36A;color:#0B0B0D;font-weight:600;font-size:14px;padding:12px 32px;border-radius:8px;text-decoration:none">Go to Dashboard</a>
</div>`,
    },
    {
      name: 'password_reset',
      label: 'Password Reset',
      subject: 'Reset your Tirbeo password',
      variables: JSON.stringify([{ name: 'otp', label: 'Reset Code', defaultValue: '123456' }]),
      htmlBody: `<div style="background:#0B0B0D;color:#F2EEE8;font-family:Inter,system-ui,sans-serif;padding:48px 24px;text-align:center;max-width:480px;margin:0 auto;border-radius:16px">
  <div style="font-size:13px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:#7B7E84;margin-bottom:32px">Tirbeo</div>
  <h1 style="font-size:24px;font-weight:700;margin:0 0 16px;color:#F2EEE8">Password Reset</h1>
  <p style="color:#A6A6A6;font-size:14px;margin:0 0 8px">Use the code below to reset your password:</p>
  <div style="font-size:48px;font-weight:700;letter-spacing:8px;margin:20px 0;color:#F2EEE8;background:rgba(255,255,255,0.06);padding:16px 24px;border-radius:12px;display:inline-block;border:1px solid rgba(255,255,255,0.08)">{{otp}}</div>
  <p style="color:#7B7E84;font-size:13px;margin:28px 0 0">This code expires in 10 minutes.</p>
  <p style="color:#7B7E84;font-size:12px;margin:16px 0 0">If you didn't request this, you can safely ignore this email.</p>
</div>`,
    },
    {
      name: 'email_verify',
      label: 'Email Verification',
      subject: 'Verify your Tirbeo email',
      variables: JSON.stringify([{ name: 'otp', label: 'Verification Code', defaultValue: '123456' }]),
      htmlBody: `<div style="background:#0B0B0D;color:#F2EEE8;font-family:Inter,system-ui,sans-serif;padding:48px 24px;text-align:center;max-width:480px;margin:0 auto;border-radius:16px">
  <div style="font-size:13px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:#7B7E84;margin-bottom:32px">Tirbeo</div>
  <h1 style="font-size:24px;font-weight:700;margin:0 0 16px;color:#F2EEE8">Verify your email</h1>
  <p style="color:#A6A6A6;font-size:14px;margin:0 0 8px">Your verification code:</p>
  <div style="font-size:48px;font-weight:700;letter-spacing:8px;margin:20px 0;color:#F2EEE8;background:rgba(255,255,255,0.06);padding:16px 24px;border-radius:12px;display:inline-block;border:1px solid rgba(255,255,255,0.08)">{{otp}}</div>
  <p style="color:#7B7E84;font-size:13px;margin:28px 0 0">This code expires in 10 minutes.</p>
</div>`,
    },
  ];

  for (const tpl of templates) {
    await prisma.emailTemplate.upsert({
      where: { name: tpl.name },
      update: {
        label: tpl.label,
        subject: tpl.subject,
        htmlBody: tpl.htmlBody,
        variables: tpl.variables as any,
      },
      create: {
        name: tpl.name,
        label: tpl.label,
        subject: tpl.subject,
        htmlBody: tpl.htmlBody,
        variables: tpl.variables as any,
      },
    });
    console.log(`  ✓ Template: ${tpl.name}`);
  }

  console.log('Email seed complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
