import { prisma } from '@/infrastructure/db/prisma';

/* Restores the E2E test user's two-factor state to what e2e-data-seed.ts wrote:
   no authenticator, no codes, no recovery address, no settings keys. */
const ID = process.env.E2E_USER_ID_OVERRIDE ?? null;

(async () => {
  const user = await prisma.user.findUnique({ where: { email: 'e2e.datauser@gmail.com' }, select: { id: true } });
  const userId = ID ?? user?.id;
  if (!userId) { console.log('no test user — nothing to restore'); process.exit(0); }
  await prisma.userSecurity.upsert({ where: { userId }, create: { userId, totpSecret: null, totpEnabled: false, backupCodes: [] }, update: { totpSecret: null, totpEnabled: false, backupCodes: [] } });
  const removed = await prisma.userEmail.deleteMany({ where: { userId, kind: { in: ['recovery', 'secondary'] } } });
  const row = await prisma.userPreferences.findUnique({ where: { userId }, select: { misc: true } });
  const misc = (row?.misc ?? {}) as any;
  if (misc.settings) {
    const { twoFactorRequireForActions: _a, twoFactorAlertSuspicious: _b, ...rest } = misc.settings as any;
    misc.settings = rest;
    await prisma.userPreferences.upsert({ where: { userId }, create: { userId, misc: misc as any }, update: { misc: misc as any } });
  }
  console.log(`restored: 2FA off, codes cleared, ${removed.count} recovery row(s) removed, prefs keys ${JSON.stringify(Object.keys(misc.settings ?? {}))}`);
  process.exit(0);
})();
