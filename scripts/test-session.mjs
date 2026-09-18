async function main() {
  const { prisma } = await import('../infrastructure/db/prisma.js');
  const u = await prisma.user.findUnique({
    where: { email: 'e2e-passkey-test@tirbeo.test' },
    select: { id: true, email: true, adminRole: true, isBanned: true, isSuspended: true },
  });
  if (!u || u.isBanned || u.isSuspended) { process.stdout.write('NOTFOUND\n'); process.exit(1); }
  process.stdout.write('FOUND:' + u.id.slice(0,8) + u.email + ' role:' + (u.adminRole || 'none') + '\n');
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
