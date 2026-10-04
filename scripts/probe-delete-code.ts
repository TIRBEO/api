/**
 * Isolate the deletion-code step: mint a code through the same core the
 * handler uses, then spend it through the same verifier. No email, no HTTP.
 * Prints only shapes and booleans — never a code or an address.
 */
import { prisma } from '@/infrastructure/db/prisma';
import { issueDeletionCode, consumeDeletionCode, DELETE_OTP_KIND } from '@/features/status/accountLifecycle';

const USER = process.env.E2E_USER_ID!;

async function main() {
  const before = await prisma.otp.findMany({
    where: { userId: USER },
    select: { kind: true, attempts: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  console.log('rows before:', before.map((r) => ({ kind: r.kind, attempts: r.attempts, ageSec: Math.round((Date.now() - r.createdAt.getTime()) / 1000), expired: r.expiresAt < new Date() })));

  const issued = await issueDeletionCode(USER, 'probe@example.invalid');
  if (!issued.ok) { console.log('ISSUE refused (cooldown)', Math.ceil(issued.remainingMs / 1000) + 's'); return; }
  console.log('issue: ok, code shape', /^\d{6}$/.test(issued.code) ? '6 digits' : 'NOT 6 DIGITS');

  const row = await prisma.otp.findFirst({ where: { userId: USER, kind: DELETE_OTP_KIND }, orderBy: { createdAt: 'desc' } });
  console.log('row written:', row ? { kind: row.kind, hasAddress: !!row.address, hasHash: !!row.otpHash, hashLen: row.otpHash?.length } : 'MISSING');

  console.log('wrong code  ->', await consumeDeletionCode(USER, '000000') === false ? 'refused (expected)' : 'ACCEPTED (bug)');
  console.log('right code  ->', await consumeDeletionCode(USER, issued.code) ? 'accepted' : 'REFUSED (bug)');
  const after = await prisma.otp.count({ where: { userId: USER, kind: DELETE_OTP_KIND } });
  console.log('probe rows left:', after);
}

main().finally(() => prisma.$disconnect());
