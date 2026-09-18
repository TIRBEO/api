const { prisma } = require('@/infrastructure/db/prisma');
async function main() {
  const EMAIL = 'e2e-passkey-test@tirbeo.test';
  console.log('Step 1: finding user...');
  const u = await prisma.user.findUnique({
    where: { email: EMAIL },
    select: { id: true, email: true, adminRole: true, isBanned: true, isSuspended: true },
  });
  if (!u || u.isBanned || u.isSuspended) { console.log('NOTFOUND'); process.exit(1); }
  console.log('Step 2: user found, id=' + u.id.slice(0,8));
  
  console.log('Step 3: loading session module...');
  const session = require('@/features/auth/session');
  console.log('Step 3a: session loaded, keys:', Object.keys(session).slice(0,15).join(','));
  
  console.log('Step 4: calling createSession...');
  const s = await session.createSession(u.id, 'E2E-Test', '127.0.0.1', u.adminRole || undefined);
  console.log('Step 5: createSession returned');
  console.log(JSON.stringify({ token: s.token.slice(0,30)+'...', refresh: s.refreshToken?.slice(0,30)+'...' }));
}
main().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
