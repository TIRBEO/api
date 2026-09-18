const { prisma } = require('@/infrastructure/db/prisma');

async function testMongoDBImport() {
  console.log('Testing whether auth/session can be imported...');
  try {
    const sessionModule = await import('../features/auth/session.js');
    console.log('session module imported OK');
  } catch (e) {
    console.log('session import FAILED:', e.message.slice(0,200));
    return;
  }

  const EMAIL = 'e2e-passkey-test@tirbeo.test';
  const u = await prisma.user.findUnique({
    where: { email: EMAIL },
    select: { id: true, email: true, adminRole: true, isBanned: true, isSuspended: true },
  });
  if (!u || u.isBanned || u.isSuspended) { console.log('NOTFOUND'); process.exit(1); }

  console.log('USER:' + u.id.slice(0,8) + ' adminRole:' + (u.adminRole || 'none'));
  console.log('Now calling createSession...');
  
  const { createSession } = await import('../features/auth/session.js');
  const s = await createSession(u.id, 'E2E-Passkey-Test', '127.0.0.1', u.adminRole || undefined);
  console.log(JSON.stringify({ token: s.token.slice(0,30)+'...', refreshToken: s.refreshToken?.slice(0,30)+'...' }));
}

testMongoDBImport().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
