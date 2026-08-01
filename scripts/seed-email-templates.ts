import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL }) });

const templates: any[] = [
  {
    name: 'signup_otp',
    subject: 'Your Tirbeo verification code is {{otp}}',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Verify Your Email</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Verify your email</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Complete your account setup securely.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Use the verification code below to activate your Tirbeo account. This code expires in <strong style="color:#202124;">10 minutes</strong>.</p><table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7ff;border:2px dashed #1A73E8;border-radius:14px;"><tr><td align="center" style="padding:32px;font-size:40px;font-weight:700;letter-spacing:12px;color:#1A73E8;font-family:monospace;">{{otp}}</td></tr></table><div style="margin:36px 0;height:1px;background:#f1f3f4;"></div><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">If you didn't request this verification, you can safely ignore this email.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "otp",
            "label": "Otp",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'login_otp',
    subject: 'Your Tirbeo login code is {{otp}}',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your Login Code</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Your login code</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Use this code to sign in to your account.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Here is your login verification code. It expires in <strong style="color:#202124;">10 minutes</strong>.</p><table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7ff;border:2px dashed #1A73E8;border-radius:14px;"><tr><td align="center" style="padding:32px;font-size:40px;font-weight:700;letter-spacing:12px;color:#1A73E8;font-family:monospace;">{{otp}}</td></tr></table><div style="margin:36px 0;height:1px;background:#f1f3f4;"></div><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">If you didn't request this login, you can safely ignore this email.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "otp",
            "label": "Otp",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'welcome',
    subject: 'Welcome to Tirbeo, {{name}}!',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Welcome to Tirbeo</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e8eaed;border-radius:16px;overflow:hidden;"><tr><td align="center" style="padding:56px 40px;background:linear-gradient(135deg,#1A73E8,#1557B0);"><img src="{{logoUrl}}" width="60" alt="Tirbeo" style="display:block;margin:0 auto 20px;"><h1 style="margin:0;color:#FFFFFF;font-size:34px;font-weight:700;">Welcome to Tirbeo</h1><p style="margin:18px 0 0;color:rgba(255,255,255,.92);font-size:17px;line-height:30px;">Your workspace is ready. Let's build something amazing together.</p></td></tr><tr><td style="padding:48px 40px;background:#ffffff;"><p style="margin:0;color:#202124;font-size:20px;font-weight:600;">Hi {{name}},</p><p style="margin:22px 0;color:#5f6368;font-size:16px;line-height:30px;">Thanks for joining <strong style="color:#202124;">Tirbeo</strong>. Your account has been created successfully and you're ready to start exploring everything our platform has to offer.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:18px;background:#f0f7ff;border:1px solid #e8eaed;border-radius:12px;"><p style="margin:0;font-size:15px;color:#202124;font-weight:600;">Explore Communities</p><p style="margin:10px 0 0;color:#5f6368;font-size:14px;line-height:24px;">Discover discussions and connect with people who share your interests.</p></td></tr></table><div style="margin:36px 0;height:1px;background:#f1f3f4;"></div><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">Questions? Visit our <a href="https://tirbeo.app/help" style="color:#1A73E8;text-decoration:none;">Help Center</a></p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "name",
            "label": "Name",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'password_reset_otp',
    subject: 'Your Tirbeo password reset code is {{otp}}',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Reset Your Password</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Reset your password</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Use the code below to reset your password.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">We received a request to reset the password for your Tirbeo account. Use the code below to reset your password. This code expires in <strong style="color:#202124;">15 minutes</strong>.</p><table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7ff;border:2px dashed #1A73E8;border-radius:14px;"><tr><td align="center" style="padding:32px;font-size:40px;font-weight:700;letter-spacing:12px;color:#1A73E8;font-family:monospace;">{{otp}}</td></tr></table><div style="margin:36px 0;height:1px;background:#f1f3f4;"></div><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">If you didn't request this, you can safely ignore this email.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "otp",
            "label": "Otp",
            "defaultValue": ""
        },
        {
            "name": "name",
            "label": "Name",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'password_reset_link',
    subject: 'Reset your Tirbeo password',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Reset Your Password</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Reset your password</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Click the link below to securely reset your password.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">We received a request to reset the password for your Tirbeo account. Click the button below to reset it. This link expires in <strong style="color:#202124;">1 hour</strong>.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="{{resetUrl}}" style="display:inline-block;padding:16px 44px;background:#1A73E8;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(26,115,232,.25);">Reset Password</a></td></tr></table><p style="margin:32px 0 0;font-size:14px;line-height:24px;color:#80868b;">If the button doesn't work, copy and paste this link:</p><p style="font-size:13px;line-height:20px;color:#1A73E8;word-break:break-all;">{{resetUrl}}</p><div style="margin:36px 0;height:1px;background:#f1f3f4;"></div><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">If you didn't request this, you can safely ignore this email.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "name",
            "label": "Name",
            "defaultValue": ""
        },
        {
            "name": "resetUrl",
            "label": "ResetUrl",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'verify_email',
    subject: 'Verify your Tirbeo email',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Verify Your Email</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Verify your email</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Confirm your email address securely.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Your verification code:</p><table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7ff;border:2px dashed #1A73E8;border-radius:14px;"><tr><td align="center" style="padding:32px;font-size:40px;font-weight:700;letter-spacing:12px;color:#1A73E8;font-family:monospace;">{{otp}}</td></tr></table><p style="margin:28px 0 0;font-size:15px;line-height:26px;color:#80868b;">This code expires in 10 minutes.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "otp",
            "label": "Otp",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'magic_link',
    subject: 'Sign in to Tirbeo',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Sign in to Tirbeo</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Sign in to Tirbeo</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">One click and you are in.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hi {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Click the button below to sign in to your Tirbeo account. This link expires in <strong style="color:#202124;">15 minutes</strong>.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="{{magicLink}}" style="display:inline-block;padding:16px 44px;background:#1A73E8;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(26,115,232,.25);">Sign In to Tirbeo</a></td></tr></table><p style="margin:32px 0 0;font-size:14px;line-height:24px;color:#80868b;">If the button does not work, copy and paste this link into your browser:</p><p style="margin:8px 0 0;font-size:13px;line-height:20px;color:#1A73E8;word-break:break-all;">{{magicLink}}</p><div style="margin:36px 0;height:1px;background:#f1f3f4;"></div><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">If you didn't request this, you can safely ignore it.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "name",
            "label": "Name",
            "defaultValue": ""
        },
        {
            "name": "magicLink",
            "label": "MagicLink",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'notification_digest',
    subject: 'Your Tirbeo digest — {{count}} new updates',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your Tirbeo Digest</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Your Digest</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">You have <strong style="color:#ffffff;">{{count}}</strong> new updates.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Here's what's new since your last visit:</p>{{digestItems}}<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="{{dashboardUrl}}" style="display:inline-block;padding:16px 44px;background:#1A73E8;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(26,115,232,.25);">View All Updates</a></td></tr></table><div style="margin:36px 0;height:1px;background:#f1f3f4;"></div><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">You received this email because you have notifications enabled. <a href="{{dashboardUrl}}/settings/notifications" style="color:#1A73E8;text-decoration:none;">Manage preferences</a></p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "count",
            "label": "Count",
            "defaultValue": ""
        },
        {
            "name": "name",
            "label": "Name",
            "defaultValue": ""
        },
        {
            "name": "digestItems",
            "label": "DigestItems",
            "defaultValue": ""
        },
        {
            "name": "dashboardUrl",
            "label": "DashboardUrl",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'form_submission_confirmation',
    subject: 'Form submitted successfully',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Form Submitted</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Form submitted</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Your response has been recorded.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Thank you for submitting the form <strong style="color:#202124;">{{formName}}</strong>. Your response has been recorded successfully.</p><div style="margin:36px 0;height:1px;background:#f1f3f4;"></div><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">If you didn't submit this form, you can ignore this email.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "name",
            "label": "Name",
            "defaultValue": ""
        },
        {
            "name": "formName",
            "label": "FormName",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'form_response',
    subject: 'New response to "{{formTitle}}"',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>New Form Response</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">New Form Response</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">A new response was submitted to your form.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">A new response has been submitted to your form <strong style="color:#202124;">{{formTitle}}</strong>.</p><div style="background:#f0f7ff;border:1px solid #e8eaed;border-radius:12px;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Respondent:</strong> {{respondentName}} ({{respondentEmail}})</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Submitted:</strong> {{submittedAt}}</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Response ID:</strong> {{responseId}}</p></div><h2 style="font-size:16px;color:#202124;margin:16px 0 8px;">Responses</h2><div style="margin:16px 0;">{{answers}}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="{{adminUrl}}" style="display:inline-block;padding:16px 44px;background:#1A73E8;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(26,115,232,.25);">View in Admin</a></td></tr></table></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "formTitle",
            "label": "FormTitle",
            "defaultValue": ""
        },
        {
            "name": "respondentName",
            "label": "RespondentName",
            "defaultValue": ""
        },
        {
            "name": "respondentEmail",
            "label": "RespondentEmail",
            "defaultValue": ""
        },
        {
            "name": "submittedAt",
            "label": "SubmittedAt",
            "defaultValue": ""
        },
        {
            "name": "responseId",
            "label": "ResponseId",
            "defaultValue": ""
        },
        {
            "name": "answers",
            "label": "Answers",
            "defaultValue": ""
        },
        {
            "name": "adminUrl",
            "label": "AdminUrl",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'form_notification',
    subject: 'New form submission: {{formTitle}}',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>New Form Submission</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">New submission</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">A new submission was received.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">A new submission was received for <strong style="color:#202124;">{{formTitle}}</strong>.</p>{{submissionData}}<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="{{formUrl}}" style="display:inline-block;padding:16px 44px;background:#1A73E8;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(26,115,232,.25);">View Submission</a></td></tr></table><div style="margin:36px 0;height:1px;background:#f1f3f4;"></div><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">This is an automated notification from Tirbeo Forms.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "formTitle",
            "label": "FormTitle",
            "defaultValue": ""
        },
        {
            "name": "submissionData",
            "label": "SubmissionData",
            "defaultValue": ""
        },
        {
            "name": "formUrl",
            "label": "FormUrl",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'account_recovery',
    subject: 'Your Tirbeo account recovery code',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Account Recovery</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Account recovery</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Use this code to recover your account.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Use this code to recover your Tirbeo account. This code expires in <strong style="color:#202124;">15 minutes</strong>.</p><table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7ff;border:2px dashed #1A73E8;border-radius:14px;"><tr><td align="center" style="padding:32px;font-size:40px;font-weight:700;letter-spacing:12px;color:#1A73E8;font-family:monospace;">{{otp}}</td></tr></table><div style="margin:36px 0;height:1px;background:#f1f3f4;"></div><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">If you didn't request this, you can safely ignore this email.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "otp",
            "label": "Otp",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'password_changed',
    subject: 'Your Tirbeo password was changed',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Password Changed</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Password changed</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Your password was updated successfully.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Your Tirbeo password was changed successfully.</p><div style="background:#f0f7ff;border:1px solid #e8eaed;border-radius:12px;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Time:</strong> {{changedAt}}</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">IP:</strong> {{ipAddress}}</p></div><p style="margin:20px 0 0;font-size:14px;line-height:24px;color:#80868b;">If you didn't make this change, please reset your password immediately or contact support.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "name",
            "label": "Name",
            "defaultValue": ""
        },
        {
            "name": "changedAt",
            "label": "ChangedAt",
            "defaultValue": ""
        },
        {
            "name": "ipAddress",
            "label": "IpAddress",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'suspicious_login',
    subject: 'Suspicious login detected on your Tirbeo account',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Security Alert</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#b91c1c,#7f1d1d,#4a1a1a);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Suspicious login detected</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">We noticed a sign-in from an unusual location.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">We noticed a sign-in to your Tirbeo account from an unusual location or device.</p><div style="background:#fff3e0;border:1px solid #ffe0b2;border-radius:12px;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Location:</strong> {{location}}</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Device:</strong> {{device}}</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Time:</strong> {{loginTime}}</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">IP:</strong> {{ipAddress}}</p></div><p style="margin:20px 0 0;font-size:14px;line-height:24px;color:#80868b;">If this was you, you can ignore this alert. If not, please secure your account immediately.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="{{dashboardUrl}}" style="display:inline-block;padding:16px 44px;background:#1A73E8;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(26,115,232,.25);">Review Account</a></td></tr></table></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "name",
            "label": "Name",
            "defaultValue": ""
        },
        {
            "name": "location",
            "label": "Location",
            "defaultValue": ""
        },
        {
            "name": "device",
            "label": "Device",
            "defaultValue": ""
        },
        {
            "name": "loginTime",
            "label": "LoginTime",
            "defaultValue": ""
        },
        {
            "name": "ipAddress",
            "label": "IpAddress",
            "defaultValue": ""
        },
        {
            "name": "dashboardUrl",
            "label": "DashboardUrl",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'login_alert',
    subject: 'New sign-in to your Tirbeo account',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>New Sign-in</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">New sign-in detected</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">A new sign-in was detected on your account.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">A new sign-in was detected on your Tirbeo account. If this was you, you can ignore this email.</p><div style="background:#f0f7ff;border:1px solid #e8eaed;border-radius:14px;padding:20px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Location:</strong> {{location}}</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Device:</strong> {{device}}</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Time:</strong> {{loginTime}}</p></div><p style="margin:20px 0 0;font-size:14px;line-height:24px;color:#80868b;">If this wasn't you, please change your password immediately and review your active sessions.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="{{dashboardUrl}}" style="display:inline-block;padding:16px 44px;background:#1A73E8;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(26,115,232,.25);">Review Account</a></td></tr></table></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "name",
            "label": "Name",
            "defaultValue": ""
        },
        {
            "name": "location",
            "label": "Location",
            "defaultValue": ""
        },
        {
            "name": "device",
            "label": "Device",
            "defaultValue": ""
        },
        {
            "name": "loginTime",
            "label": "LoginTime",
            "defaultValue": ""
        },
        {
            "name": "dashboardUrl",
            "label": "DashboardUrl",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'admin_alert',
    subject: '[Admin] {{subject}}',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Alert</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#b91c1c,#7f1d1d,#4a1a1a);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Admin Alert</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">{{subject}}</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello Admin,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">{{message}}</p><div style="background:#f0f7ff;border:1px solid #e8eaed;border-radius:12px;padding:16px;margin:16px 0;">{{details}}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="{{dashboardUrl}}" style="display:inline-block;padding:16px 44px;background:#1A73E8;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(26,115,232,.25);">View Admin Dashboard</a></td></tr></table><div style="margin:36px 0;height:1px;background:#f1f3f4;"></div><p style="margin:0;font-size:13px;line-height:22px;color:#80868b;">This is an automated alert from Tirbeo. Do not reply to this email.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "subject",
            "label": "Subject",
            "defaultValue": ""
        },
        {
            "name": "message",
            "label": "Message",
            "defaultValue": ""
        },
        {
            "name": "details",
            "label": "Details",
            "defaultValue": ""
        },
        {
            "name": "dashboardUrl",
            "label": "DashboardUrl",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'system_alert',
    subject: '[System] {{subject}}',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>System Alert</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#b91c1c,#7f1d1d,#4a1a1a);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">System Alert</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">{{message}}</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">{{message}}</p><div style="background:#f0f7ff;border:1px solid #e8eaed;border-radius:12px;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Service:</strong> {{service}}</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Time:</strong> {{alertTime}}</p></div></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "subject",
            "label": "Subject",
            "defaultValue": ""
        },
        {
            "name": "message",
            "label": "Message",
            "defaultValue": ""
        },
        {
            "name": "service",
            "label": "Service",
            "defaultValue": ""
        },
        {
            "name": "alertTime",
            "label": "AlertTime",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'invoice',
    subject: 'Your Tirbeo receipt — {{plan}}',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Receipt</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Receipt</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Thank you for your payment.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Thank you for your payment, {{name}}.</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr><td style="padding:10px 0;border-bottom:1px solid #e8eaed;font-size:14px;color:#5f6368;">Plan</td><td style="padding:10px 0;border-bottom:1px solid #e8eaed;font-size:14px;color:#202124;font-weight:600;text-align:right;">{{plan}}</td></tr><tr><td style="padding:10px 0;border-bottom:1px solid #e8eaed;font-size:14px;color:#5f6368;">Amount</td><td style="padding:10px 0;border-bottom:1px solid #e8eaed;font-size:14px;color:#202124;font-weight:600;text-align:right;">{{amount}}</td></tr><tr><td style="padding:10px 0;border-bottom:1px solid #e8eaed;font-size:14px;color:#5f6368;">Date</td><td style="padding:10px 0;border-bottom:1px solid #e8eaed;font-size:14px;color:#202124;font-weight:600;text-align:right;">{{date}}</td></tr></table></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "plan",
            "label": "Plan",
            "defaultValue": ""
        },
        {
            "name": "name",
            "label": "Name",
            "defaultValue": ""
        },
        {
            "name": "amount",
            "label": "Amount",
            "defaultValue": ""
        },
        {
            "name": "date",
            "label": "Date",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'form_published',
    subject: 'Your form "{{formTitle}}" is now live',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Form Published</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Form is now live</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Your form is accepting responses.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Your form <strong style="color:#202124;">{{formTitle}}</strong> has been published and is now accepting responses.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="{{formUrl}}" style="display:inline-block;padding:16px 44px;background:#1A73E8;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(26,115,232,.25);">View Form</a></td></tr></table></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "formTitle",
            "label": "FormTitle",
            "defaultValue": ""
        },
        {
            "name": "formUrl",
            "label": "FormUrl",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'form_closed',
    subject: 'Your form "{{formTitle}}" has been closed',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Form Closed</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Form closed</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Your form is no longer accepting responses.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Your form <strong style="color:#202124;">{{formTitle}}</strong> has been closed and is no longer accepting responses.</p><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">You can reopen it anytime from your dashboard.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "formTitle",
            "label": "FormTitle",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'form_deleted',
    subject: 'Your form "{{formTitle}}" has been deleted',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Form Deleted</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#b91c1c,#7f1d1d,#4a1a1a);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Form deleted</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Your form has been permanently deleted.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Your form <strong style="color:#202124;">{{formTitle}}</strong> has been permanently deleted.</p><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">This action cannot be undone. If this was a mistake, please contact support.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "formTitle",
            "label": "FormTitle",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'form_archived',
    subject: 'Your form "{{formTitle}}" has been archived',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Form Archived</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Form archived</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Your form has been archived.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Your form <strong style="color:#202124;">{{formTitle}}</strong> has been archived.</p><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">Archived forms are hidden from your dashboard but can be restored anytime.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "formTitle",
            "label": "FormTitle",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'response_updated',
    subject: 'A response to "{{formTitle}}" was updated',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Response Updated</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Response updated</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">A form response was modified.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">A response to your form <strong style="color:#202124;">{{formTitle}}</strong> was updated.</p><div style="background:#f0f7ff;border:1px solid #e8eaed;border-radius:12px;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Response ID:</strong> {{responseId}}</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Updated at:</strong> {{updatedAt}}</p></div></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "formTitle",
            "label": "FormTitle",
            "defaultValue": ""
        },
        {
            "name": "responseId",
            "label": "ResponseId",
            "defaultValue": ""
        },
        {
            "name": "updatedAt",
            "label": "UpdatedAt",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'response_deleted',
    subject: 'A response to "{{formTitle}}" was deleted',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Response Deleted</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#b91c1c,#7f1d1d,#4a1a1a);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Response deleted</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">A form response was removed.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">A response to your form <strong style="color:#202124;">{{formTitle}}</strong> was deleted.</p><div style="background:#f0f7ff;border:1px solid #e8eaed;border-radius:12px;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Response ID:</strong> {{responseId}}</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Deleted at:</strong> {{deletedAt}}</p></div></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "formTitle",
            "label": "FormTitle",
            "defaultValue": ""
        },
        {
            "name": "responseId",
            "label": "ResponseId",
            "defaultValue": ""
        },
        {
            "name": "deletedAt",
            "label": "DeletedAt",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'ticket_created',
    subject: 'Support ticket opened: {{ticketSubject}}',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Support Ticket Opened</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Support ticket opened</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Your support ticket has been created.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Your support ticket has been created.</p><div style="background:#f0f7ff;border:1px solid #e8eaed;border-radius:12px;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Ticket:</strong> {{ticketId}}</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Subject:</strong> {{ticketSubject}}</p><p style="margin:8px 0 0;font-size:14px;color:#5f6368;"><strong style="color:#202124;">Status:</strong> {{ticketStatus}}</p></div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="{{ticketUrl}}" style="display:inline-block;padding:16px 44px;background:#1A73E8;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(26,115,232,.25);">View Ticket</a></td></tr></table></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "ticketSubject",
            "label": "TicketSubject",
            "defaultValue": ""
        },
        {
            "name": "ticketId",
            "label": "TicketId",
            "defaultValue": ""
        },
        {
            "name": "ticketStatus",
            "label": "TicketStatus",
            "defaultValue": ""
        },
        {
            "name": "ticketUrl",
            "label": "TicketUrl",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'ticket_updated',
    subject: 'Update on your support ticket {{ticketId}}',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ticket Updated</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Ticket updated</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Your support ticket has a new update.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Your support ticket <strong style="color:#202124;">{{ticketId}}</strong> has been updated.</p><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">{{updateMessage}}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="{{ticketUrl}}" style="display:inline-block;padding:16px 44px;background:#1A73E8;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(26,115,232,.25);">View Ticket</a></td></tr></table></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "ticketId",
            "label": "TicketId",
            "defaultValue": ""
        },
        {
            "name": "updateMessage",
            "label": "UpdateMessage",
            "defaultValue": ""
        },
        {
            "name": "ticketUrl",
            "label": "TicketUrl",
            "defaultValue": ""
        }
    ],
  },
  {
    name: 'ticket_closed',
    subject: 'Your support ticket {{ticketId}} has been closed',
    htmlBody: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ticket Closed</title></head><body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fa;padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(60,64,67,.12);"><tr><td style="background:linear-gradient(135deg,#1A73E8,#1557B0);padding:52px 48px;text-align:center;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><img src="{{logoUrl}}" width="56" alt="Tirbeo" style="display:block;margin:0 auto 22px;border-radius:12px;"></td></tr><tr><td align="center"><h1 style="margin:0;font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-.01em;">Ticket closed</h1><p style="margin:16px 0 0;font-size:16px;line-height:28px;color:rgba(255,255,255,.92);">Your support ticket has been resolved.</p></td></tr></table></td></tr><tr><td style="padding:52px 48px;background:#ffffff;"><p style="margin:0;font-size:16px;line-height:28px;color:#5f6368;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#5f6368;">Your support ticket <strong style="color:#202124;">{{ticketId}}</strong> has been closed.</p><p style="margin:0;font-size:14px;line-height:24px;color:#80868b;">If you still need help, feel free to open a new ticket.</p></td></tr><tr><td style="padding:36px 48px;background:#ffffff;text-align:center;border-top:1px solid #f1f3f4;"><p style="margin:0;font-size:16px;font-weight:700;color:#202124;">Tirbeo</p><p style="margin:14px 0 0;font-size:13px;color:#80868b;line-height:22px;">&copy; 2026 Tirbeo. All rights reserved.<br>123 Market St, Suite 400, San Francisco, CA 94105</p></td></tr></table></td></tr></table></body></html>`,
    variables: [
        {
            "name": "ticketId",
            "label": "TicketId",
            "defaultValue": ""
        }
    ],
  },
];

async function main() {
  console.log("Seeding email templates...");
  for (const tpl of templates) {
    await prisma.emailTemplate.upsert({
      where: { name: tpl.name },
      update: {
        subject: tpl.subject,
        htmlBody: tpl.htmlBody,
        label: tpl.name.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
        variables: tpl.variables,
      },
      create: {
        name: tpl.name,
        subject: tpl.subject,
        htmlBody: tpl.htmlBody,
        label: tpl.name.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
        variables: tpl.variables,
      },
    });
  }
  console.log(`Seeded ${templates.length} email templates.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());