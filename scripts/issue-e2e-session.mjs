const { prisma } = require('../infrastructure/db/prisma');
const { createSession } = require('../features/auth/session');

const EMAIL = 'e2e-passkey-test@tirbeo.test';
const u = prisma.user.findUnique({
  where: { email: EMAIL },
  select: { id: true, email: true, adminRole: true, isBanned: true, isSuspended: true },
});
if (!u || u.isBanned || u.isSuspended) { process.stdout.write('NOTFOUND\n'); process.exit(1); }

const s = createSession(u.id, 'E2E-Passkey-Test', '127.0.0.1', u.adminRole || undefined);
const out = JSON.stringify({ token: s.token, refreshToken: s.refreshToken });
process.stdout.write(out + '\n');
