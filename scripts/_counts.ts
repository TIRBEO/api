import { prisma } from '@/infrastructure/db/prisma';
async function main() {
  const [devices, sessions, live, push, logins, ok, bad, passkeys, users] = await Promise.all([
    prisma.userDevice.count(), prisma.userSession.count(),
    prisma.userSession.count({ where: { status: 'active', revokedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.pushSubscription.count(), prisma.userLogin.count(),
    prisma.userLogin.count({ where: { success: true } }), prisma.userLogin.count({ where: { success: false } }),
    prisma.passkey.count(), prisma.user.count(),
  ]);
  console.info("COUNTS " + JSON.stringify({ users, devices, sessions, live, push, logins, ok, bad, passkeys }));
  const d = await prisma.userDevice.findMany({ take: 3, select: { deviceName: true, userAgent: true, location: true, status: true, lastUsedAt: true } });
  console.log(JSON.stringify(d, null, 1));
  const s = await prisma.userSession.findMany({ take: 3, select: { deviceName: true, location: true, status: true, expiresAt: true, lastUsedAt: true } });
  console.log(JSON.stringify(s, null, 1));
}
main().finally(() => process.exit(0));
