/**
 * Phase E slice #11 fixture: the per-account passkey cap.
 *
 *   fill    — put MAX fake keys on the test user so the account is full
 *   empty   — delete exactly the rows this script wrote
 *   show    — print every passkey row on the account, credential id included
 *
 * The credential ids are marked so nothing else can be caught in the clean-up,
 * and the public keys are filler: the cap is checked before any signature is.
 *
 *   cd apps/api && npx tsx --env-file=.env.local scripts/e2e-passkey-cap.ts fill
 */
import { prisma } from '@/infrastructure/db/prisma';

const EMAIL = 'e2e.datauser@gmail.com';
const MARK = 'e2e-cap-';
const MAX = 5;

async function main() {
  const mode = process.argv[2] || 'fill';
  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (!user) {
    console.log('no test user');
    return;
  }

  if (mode === 'show') {
    const rows = await prisma.passkey.findMany({
      where: { userId: user.id },
      select: { id: true, credentialId: true, deviceName: true, transports: true, credentialPubkey: true },
      orderBy: { createdAt: 'asc' },
    });
    console.log(JSON.stringify(rows.map((row) => ({
      id: row.id,
      credentialId: row.credentialId,
      deviceName: row.deviceName,
      transports: row.transports,
      pubkeyBytes: row.credentialPubkey.byteLength,
    })), null, 2));
    return;
  }

  if (mode === 'empty') {
    const gone = await prisma.passkey.deleteMany({ where: { userId: user.id, credentialId: { startsWith: MARK } } });
    const left = await prisma.passkey.count({ where: { userId: user.id } });
    console.log(`removed ${gone.count} filler key(s); ${left} real key(s) left on the account`);
    return;
  }

  const existing = await prisma.passkey.count({ where: { userId: user.id } });
  for (let i = existing; i < MAX; i++) {
    await prisma.passkey.create({
      data: {
        userId: user.id,
        credentialId: `${MARK}${i}`,
        credentialPubkey: Buffer.from(`filler-public-key-${i}`),
        counter: BigInt(0),
        transports: 'internal',
        deviceName: `Filler ${i + 1}`,
      },
    });
  }
  const count = await prisma.passkey.count({ where: { userId: user.id } });
  console.log(`account now holds ${count} passkey(s), ${count - existing} written by this run`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(0));
