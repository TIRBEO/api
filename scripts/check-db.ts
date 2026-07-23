import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const tables = await p.$queryRawUnsafe<{tablename: string}[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  console.log('=== TABLES ===');
  for (const t of tables) console.log(' ', t.tablename);

  console.log('\n=== COUNTS ===');
  console.log('Districts:', await p.district.count());
  console.log('Users:', await p.user.count());
  console.log('Sessions:', await p.session.count());
  console.log('Notifications:', await p.notification.count());
  console.log('NotificationPrefs:', await p.notificationPreference.count());
  console.log('Workspaces:', await p.workspace.count());
  console.log('Memberships:', await p.membership.count());
  console.log('Roles:', await p.appRole.count());
  console.log('UserRoles:', await p.userRole.count());
  console.log('Routes:', await p.route.count());
  console.log('Logs:', await p.log.count());
  console.log('Blocklist:', await p.blocklist.count());
  console.log('SiteConfigs:', await p.siteConfig.count());
  console.log('Otps:', await p.otp.count());
  console.log('SignupOtps:', await p.signupOtp.count());
  console.log('EmailConfigs:', await p.emailConfig.count());
  console.log('EmailTemplates:', await p.emailTemplate.count());
  console.log('ThemeConfigs:', await p.themeConfig.count());
  console.log('Integrations:', await p.integration.count());
  console.log('AuditEvents:', await p.auditEvent.count());
  console.log('SecurityEvents:', await p.securityEvent.count());
  console.log('RecoveryCodes:', await p.recoveryCode.count());
  console.log('Subscribers:', await p.subscriber.count());
  console.log('ContentReports:', await p.contentReport.count());
  console.log('Media:', await p.media.count());

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
