import { config } from 'dotenv';
config({ path: '.env.local' });
import { prisma } from './lib/db/prisma';
import { createNotification } from './lib/notifications';



async function main() {
  const user = await prisma.user.findFirst({
    where: { deletedAt: null, isBanned: false },
    select: { id: true, email: true, name: true },
  });
  if (!user) { console.log('NO_USER'); return; }
  console.log('USER:', user.email);

  // Ensure prefs: email + all categories ON (fresh row = defaults, but be explicit)
  await prisma.notificationPreference.upsert({
    where: { userId: user.id },
    update: { email: true, security: true, forms: true, product: true, support: true, securityEmail: true, formsEmail: true, productEmail: true, supportEmail: true, inApp: true, push: false },
    create: { userId: user.id, email: true, security: true, forms: true, product: true, support: true, securityEmail: true, formsEmail: true, productEmail: true, supportEmail: true, inApp: true, push: false },
  });

  const tests = [
    { type: 'password_changed', title: 'Password changed', body: 'Test security notification', link: '/account/security' },
    { type: 'form_response', title: 'New form response', body: 'Test forms notification', link: '/forms' },
    { type: 'product_update', title: 'Product update', body: 'Test product notification', link: '/overview' },
    { type: 'ticket_reply', title: 'Ticket reply', body: 'Test support notification', link: '/tickets' },
  ] as any[];

  for (const t of tests) {
    const notif = await createNotification({ userId: user.id, ...t, metadata: {} });
    console.log(t.type, '->', notif ? `created ${notif.id}` : 'BLOCKED');
  }

  const rows = await prisma.notification.findMany({
    where: { userId: user.id, title: { in: ['Password changed', 'New form response', 'Product update', 'Ticket reply'] } },
    orderBy: { createdAt: 'desc' },
    take: 4,
    select: { id: true, type: true, title: true, createdAt: true },
  });
  console.log('DB_ROWS:', JSON.stringify(rows.map(r => ({ type: r.type, title: r.title }))));
}

main().catch(e => { console.error('ERR', e.message); }).finally(() => prisma.$disconnect());
