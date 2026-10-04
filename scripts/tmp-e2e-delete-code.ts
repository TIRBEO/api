/* Throwaway: prove the account-deletion code step is real, then put the
   account back exactly as it was. Run with:
     cd apps/api && npx tsx --env-file=.env.local scripts/tmp-e2e-delete-code.ts
   Writes its report to /tmp/delete-code-report.txt so a slow terminal can't
   lose it.
*/
import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { SignJWT } from 'jose';
import { prisma } from '@/infrastructure/db/prisma';
import { DELETE_OTP_KIND } from '@/features/status/accountLifecycle';

const REPORT = '/tmp/delete-code-report.txt';
const E2E = '/tmp/tirbeo-e2e.env';
const pick = (k: string) => (readFileSync(E2E, 'utf8').match(new RegExp(`^export ${k}=(.*)$`, 'm')) || [])[1]?.trim();
const userId = pick('E2E_USER_ID')!;
const sessionId = pick('E2E_SESSION_ID')!;
const jwtSecret = (process.env.JWT_SECRET || '').trim().replace(/^["']|["']$/g, '');

const BASE = 'http://127.0.0.1:3000';
const say = (line: string) => { appendFileSync(REPORT, line + '\n'); };
const results: string[] = [];
const check = (name: string, pass: boolean, note = '') =>
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);

async function token(): Promise<string> {
  return new SignJWT({ sub: userId, sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(jwtSecret));
}

const call = async (jwt: string, body: unknown) => {
  const res = await fetch(`${BASE}/api/user/delete-account`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', 'x-csrf-token': 'e2ecsrftoken1' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};

const state = async () => ({
  user: await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, scheduledDeletionAt: true, deletionReason: true },
  }),
  request: await prisma.userDeletionRequest.findUnique({
    where: { userId },
    select: { finalAt: true, cancelledAt: true },
  }),
});

/** Every row this probe can create, removed again. */
async function sweep(from: Date) {
  await prisma.otp.deleteMany({ where: { userId, kind: DELETE_OTP_KIND } });
  await prisma.activityEvent.deleteMany({ where: { userId, kind: 'account.delete-code', createdAt: { gte: from } } });
  await prisma.activityEvent.deleteMany({ where: { userId, kind: 'account.delete-request', createdAt: { gte: from } } });
  const jobs = await prisma.email_jobs.findMany({
    where: { createdAt: { gte: from }, toAddress: { contains: 'e2e.datauser' } },
    select: { id: true },
  });
  if (jobs.length) {
    await prisma.email_deliveries.deleteMany({ where: { jobId: { in: jobs.map((j) => j.id) } } }).catch(() => {});
    await prisma.email_jobs.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
  }
  return jobs.length;
}

async function main() {
  writeFileSync(REPORT, `delete-code probe ${new Date().toISOString()}\n`);
  const started = new Date();
  const before = await state();
  const otpBefore = await prisma.otp.count({ where: { userId, kind: DELETE_OTP_KIND } });
  const codesBefore = await prisma.activityEvent.count({ where: { userId, kind: 'account.delete-code' } });
  say(`snapshot: status=${before.user?.status} scheduled=${before.user?.scheduledDeletionAt?.toISOString() ?? 'null'} `
    + `otp=${otpBefore} codes=${codesBefore}`);

  // A code left over from an interrupted run would trip the resend cooldown.
  await sweep(new Date(0));

  const jwt = await token();

  // 1 — asking for the code is the thing that mails it.
  const sent = await call(jwt, { step: 'request' });
  check('request returns ok', sent.status === 200 && sent.json?.ok === true, `${sent.status} ${sent.json?.message ?? sent.json?.error ?? ''}`);

  const otpRow = await prisma.otp.findFirst({ where: { userId, kind: DELETE_OTP_KIND }, orderBy: { createdAt: 'desc' } });
  check('a spendable code row exists', !!otpRow, otpRow ? `expires ${otpRow.expiresAt.toISOString()}` : 'no row');
  const codesAfter = await prisma.activityEvent.count({ where: { userId, kind: 'account.delete-code' } });
  check('the ledger says the code was sent', codesAfter === codesBefore + 1, `${codesBefore} -> ${codesAfter}`);
  const mails = await prisma.email_jobs.count({ where: { createdAt: { gte: started }, toAddress: { contains: 'e2e.datauser' } } });
  check('the mail actually left', mails >= 1, `${mails} job row(s)`);

  // 2 — asking twice inside the cooldown is refused, not silently mailed.
  const again = await call(jwt, { step: 'request' });
  check('resend too early is refused', again.status === 429, `${again.status} ${again.json?.error ?? again.json?.message ?? ''}`);

  // 3 — a wrong code must not schedule anything.
  const wrong = await call(jwt, { step: 'verify', code: otpRow ? '000000' : '123456' });
  check('wrong code refused', wrong.status === 400, `${wrong.status} ${wrong.json?.error ?? ''}`);
  const mid = await state();
  check('nothing scheduled by a wrong code',
    mid.user?.status === before.user?.status && !mid.request?.finalAt,
    `status=${mid.user?.status} finalAt=${mid.request?.finalAt?.toISOString() ?? 'none'}`);

  // 4 — the read the lock screens run on.
  const res = await fetch(`${BASE}/api/user/account-state`, {
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${jwt}` },
  });
  const json = await res.json().catch(() => null);
  check('account-state reads no deletion', res.status === 200 && json?.deletionPending === false,
    `${res.status} pending=${json?.deletionPending} status=${json?.status}`);

  // ── restore ──
  const jobsRemoved = await sweep(started);
  const after = await state();
  const otpLeft = await prisma.otp.count({ where: { userId, kind: DELETE_OTP_KIND } });
  const codesLeft = await prisma.activityEvent.count({ where: { userId, kind: 'account.delete-code' } });
  say(`restored: status=${after.user?.status} scheduled=${after.user?.scheduledDeletionAt?.toISOString() ?? 'null'} `
    + `otp=${otpLeft} codes=${codesLeft} (was ${codesBefore}) mailjobs_removed=${jobsRemoved} request=${JSON.stringify(after.request)}`);
  check('code row cleaned', otpLeft === otpBefore, `${otpBefore} -> ${otpLeft}`);
  check('status unchanged', after.user?.status === before.user?.status && after.user?.scheduledDeletionAt === before.user?.scheduledDeletionAt);

  say('\n' + results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  say(`\n${results.length - failed} PASS / ${failed} FAIL`);
  console.log('report written to ' + REPORT);
}

main().catch((e) => { say('probe blew up: ' + (e?.message || e)); console.error(e?.message || e); process.exit(1); })
  .finally(() => prisma.$disconnect());
