import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL }) });

async function main() {
  console.log('Seeding defaults...');

  // Free Plan
  const freePlan = await prisma.plans.upsert({
    where: { slug: 'free' },
    update: {},
    create: {
      name: 'Free',
      slug: 'free',
      description: 'Free tier with basic features',
      price: 0,
      isFree: true,
      isPublic: true,
      sortOrder: 0,
      features: ['basic-profiles', 'basic-support'],
      limits: { users: 1, storage: 100, apiRequests: 1000 },
    },
  });
  console.log(`Plan: ${freePlan.name}`);

  // Feature Flags
  const flags = [
    { key: 'messaging.enabled', name: 'Messaging', description: 'Enable messaging features' },
    { key: 'social.enabled', name: 'Social', description: 'Enable social features' },
    { key: 'communities.enabled', name: 'Communities', description: 'Enable communities' },
    { key: 'billing.enabled', name: 'Billing', description: 'Enable billing features' },
    { key: 'support.enabled', name: 'Support', description: 'Enable support ticket system' },
    { key: 'blogs.enabled', name: 'Blogs', description: 'Enable blog system' },
    { key: 'forms.userCreation.enabled', name: 'User Form Creation', description: 'Enable user-created forms' },
  ];
  for (const flag of flags) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      update: {},
      create: { key: flag.key, name: flag.name, description: flag.description, isActive: true },
    });
  }
  console.log(`Feature flags: ${flags.length}`);

  // System Services
  const services = [
    { name: 'API', slug: 'api', type: 'api', status: 'operational', updatedAt: new Date() },
    { name: 'Database', slug: 'database', type: 'database', status: 'operational', updatedAt: new Date() },
    { name: 'Authentication', slug: 'auth', type: 'service', status: 'operational', updatedAt: new Date() },
    { name: 'Storage', slug: 'storage', type: 'service', status: 'operational', updatedAt: new Date() },
    { name: 'Email', slug: 'email', type: 'service', status: 'operational', updatedAt: new Date() },
  ];
  for (const svc of services) {
    await prisma.system_services.upsert({
      where: { slug: svc.slug },
      update: {},
      create: svc,
    });
  }
  console.log(`System services: ${services.length}`);

  // Default Settings
  const settings = [
    { key: 'site.name', value: 'Tirbeo', type: 'string', group: 'general', label: 'Site Name' },
    { key: 'site.description', value: 'Tirbeo Platform', type: 'string', group: 'general', label: 'Site Description' },
    { key: 'auth.allowRegistration', value: true, type: 'boolean', group: 'auth', label: 'Allow Registration' },
    { key: 'auth.passwordMinLength', value: 8, type: 'number', group: 'auth', label: 'Min Password Length' },
    { key: 'auth.maxLoginAttempts', value: 5, type: 'number', group: 'auth', label: 'Max Login Attempts' },
    { key: 'auth.sessionDuration', value: 604800, type: 'number', group: 'auth', label: 'Session Duration (seconds)' },
    { key: 'billing.currency', value: 'usd', type: 'string', group: 'billing', label: 'Currency' },
    { key: 'storage.maxFileSize', value: 10485760, type: 'number', group: 'storage', label: 'Max File Size (bytes)' },
    { key: 'support.defaultQueue', value: 'general', type: 'string', group: 'support', label: 'Default Support Queue' },
  ];
  for (const s of settings) {
    await prisma.setting.upsert({
      where: { key: s.key },
      update: {},
      create: s,
    });
  }
  console.log(`Settings: ${settings.length}`);

  // Default Apps (requires a system user as owner)
  let systemUser = await prisma.user.findFirst({ where: { email: 'system@tirbeo.app' } });
  if (!systemUser) {
    systemUser = await prisma.user.create({
      data: { email: 'system@tirbeo.app', name: 'System', adminRole: 'super_admin', emailVerified: true },
    });
  }
  const apps = [
    { name: 'Forms', slug: 'forms', description: 'Create and manage forms', icon: 'FileText', url: '/forms', isPublic: true, ownerId: systemUser.id, updatedAt: new Date() },
    { name: 'Dashboard', slug: 'dashboard', description: 'Your central control center', icon: 'LayoutDashboard', url: '/dashboard', isPublic: true, ownerId: systemUser.id, updatedAt: new Date() },
    { name: 'Account', slug: 'account', description: 'Manage your account settings', icon: 'UserCircle', url: '/settings/account', isPublic: true, ownerId: systemUser.id, updatedAt: new Date() },
  ];
  for (const app of apps) {
    await prisma.apps.upsert({
      where: { slug: app.slug },
      update: {},
      create: app,
    });
  }
  console.log(`Apps: ${apps.length}`);

  // System roles: admin (full access) and user (basic access)
  const userRole = await prisma.app_roles.upsert({
    where: { name: 'user' },
    update: {},
    create: {
      name: 'user',
      description: 'Standard user with basic access',
      color: '#188038',
      icon: 'user',
      isSystem: true,
      permissions: {
        'access.dashboard': true,
        'accounts.view': true,
        'settings.dashboard.view': true,
        'domains.view': true,
        'system.notifications': true,
        'system.notifications.prefs': true,
      },
    },
  });
  console.log(`Role: ${userRole.name}`);

  const allPerms: Record<string, boolean> = {
    'access.dashboard': true,
    'system.routes': true,
    'system.monitor': true,
    'system.users': true,
    'system.users.manage': true,
    'system.users.delete': true,
    'system.workspaces': true,
    'system.workspaces.delete': true,
    'landing.view': true,
    'landing.edit': true,
    'accounts.view': true,
    'accounts.edit': true,
    'settings.dashboard.view': true,
    'settings.dashboard.edit': true,
    'settings.admin.view': true,
    'settings.admin.edit': true,
    'settings.api.view': true,
    'settings.api.edit': true,
    'roles.view': true,
    'roles.create': true,
    'roles.edit': true,
    'roles.delete': true,
    'domains.view': true,
    'system.email': true,
    'system.email.templates': true,
    'system.audit': true,
    'system.notifications': true,
    'system.notifications.prefs': true,
    'system.moderation': true,
  };
  const adminRole = await prisma.app_roles.upsert({
    where: { name: 'admin' },
    update: {},
    create: {
      name: 'admin',
      description: 'Full administrative access',
      color: '#D93025',
      icon: 'shield',
      isSystem: true,
      permissions: allPerms,
    },
  });
  console.log(`Role: ${adminRole.name}`);

  // Support Queues
  const queues = [
    { name: 'General', slug: 'general', description: 'General support inquiries', updatedAt: new Date() },
    { name: 'Technical', slug: 'technical', description: 'Technical support', updatedAt: new Date() },
    { name: 'Billing', slug: 'billing', description: 'Billing and subscription inquiries', updatedAt: new Date() },
  ];
  for (const q of queues) {
    await prisma.support_queues.upsert({
      where: { slug: q.slug },
      update: {},
      create: q,
    });
  }
  console.log(`Support queues: ${queues.length}`);

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
