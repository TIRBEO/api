const { prisma } = require('@/infrastructure/db/prisma');

async function main() {
  const EMAIL = 'e2e-passkey-test@tirbeo.test';
  const u = await prisma.user.findUnique({
    where: { email: EMAIL },
    select: { id: true, email: true, adminRole: true, isBanned: true, isSuspended: true },
  });
  if (!u || u.isBanned || u.isSuspended) { console.log('NOTFOUND'); process.exit(1); }
  console.log('FOUND:' + u.id.slice(0,8) + ' role:' + (u.adminRole || 'none'));
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
