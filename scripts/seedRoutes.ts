import { prisma } from '../lib/db/prisma';

const INTERNAL_ROUTES = [
  // Auth (no session required)
  { path: 'auth/login', method: 'POST', internal: true, allowedRoles: ['guest'] },
  { path: 'auth/signup', method: 'POST', internal: true, allowedRoles: ['guest'] },
  { path: 'auth/logout', method: 'POST', internal: true, allowedRoles: ['member'] },
  // OTP (any authenticated user)
  { path: 'auth/email-otp/request', method: 'POST', internal: true, allowedRoles: ['member'] },
  { path: 'auth/email-otp/verify', method: 'POST', internal: true, allowedRoles: ['member'] },
  { path: 'auth/phone-otp/request', method: 'POST', internal: true, allowedRoles: ['member'] },
  { path: 'auth/phone-otp/verify', method: 'POST', internal: true, allowedRoles: ['member'] },
  // Google OAuth (no session required)
  { path: 'auth/google', method: 'GET', internal: true, allowedRoles: ['guest'] },
  { path: 'auth/google/callback', method: 'GET', internal: true, allowedRoles: ['guest'] },
  // Profile (any authenticated user)
  { path: 'users/me', method: 'GET', internal: true, allowedRoles: ['member'] },
  { path: 'users/me', method: 'PATCH', internal: true, allowedRoles: ['member'] },
  // Newsletter (public)
  { path: 'newsletter/subscribe', method: 'POST', internal: true, allowedRoles: ['guest'] },
  // Activity & Workspaces (any authenticated user)
  { path: 'activity', method: 'GET', internal: true, allowedRoles: ['member'] },
  { path: 'workspaces', method: 'GET', internal: true, allowedRoles: ['member'] },
  { path: 'workspaces', method: 'POST', internal: true, allowedRoles: ['member'] },
];

async function main() {
  console.log('Seeding internal routes...');

  for (const route of INTERNAL_ROUTES) {
    await prisma.route.upsert({
      where: { path_method: { path: route.path, method: route.method } },
      update: {
        internal: route.internal,
        allowedRoles: route.allowedRoles,
        enabled: true,
      },
      create: {
        path: route.path,
        method: route.method,
        target: '',
        allowedRoles: route.allowedRoles,
        internal: route.internal,
        enabled: true,
      },
    });
    console.log(`  ✓ ${route.method} ${route.path}`);
  }

  // Seed first admin from env var if provided
  const adminEmail = process.env.ADMIN_SEED_EMAIL;
  if (adminEmail) {
    const user = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (user) {
      await prisma.user.update({
        where: { email: adminEmail },
        data: { adminRole: 'super_admin' },
      });
      console.log(`  ✓ Promoted ${adminEmail} to super_admin`);
    } else {
      console.log(`  ✗ User ${adminEmail} not found. Create them via signup first.`);
    }
  }

  console.log('Seed complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
