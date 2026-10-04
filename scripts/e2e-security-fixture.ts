/**
 * Phase E slice #13 fixture for the password + recovery-email hub.
 *
 *   snapshot — prints everything the hub writes, so `restore` can put it back:
 *              the password hash (and mustChangePassword), every session row
 *              (changing a password signs the OTHER devices out, so the rows
 *              are backed up in full and re-inserted), the activity ledger rows
 *              and notifications already on file, OTP rows, and the recovery
 *              address rows on user_email. Prints `since`, the cut-off the
 *              restore uses to tell my writes from the seeded ones.
 *   otp      — stores a code I choose so the verify endpoint can be exercised
 *              without reading anybody's mail. Same hashing the real send uses.
 *   check    — E2E_SEC_PASSWORDS (one per line): does each one match the hash on
 *              file, using the same verifyPassword the login handler calls.
 *   restore  — puts every one of those back the way snapshot found it. Pass the
 *              snapshot file as E2E_SEC_SNAPSHOT (it holds the password hash).
 *
 *   cd apps/api && npx tsx --env-file=.env.local scripts/e2e-security-fixture.ts snapshot > /tmp/snap.json
 *   ...E2E_SEC_SNAPSHOT=/tmp/snap.json npx tsx --env-file=.env.local scripts/e2e-security-fixture.ts restore
 */
import { readFileSync } from 'node:fs';
import { prisma } from '@/infrastructure/db/prisma';
import { verifyPassword } from '@/features/auth/password';
import { storeOtp } from '@/features/auth/otp';

const EMAIL = 'e2e.datauser@gmail.com';
const FIXTURE_OTP = '204618';

async function main() {
  const mode = process.argv[2] || 'snapshot';
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (!user) {
    console.log(JSON.stringify({ error: 'no test user' }));
    return;
  }

  if (mode === 'otp') {
    // The same path the real send uses, binding included, so the code is only
    // spendable for the address named here.
    await storeOtp(user.id, 'email', FIXTURE_OTP, process.env.E2E_SEC_RECOVERY_EMAIL || null);
    console.log(JSON.stringify({ stored: true, code: FIXTURE_OTP, boundTo: process.env.E2E_SEC_RECOVERY_EMAIL || null }));
    return;
  }

  // The login handler's own comparison, run against whatever hash is stored
  // right now. Proves a password change actually landed without signing in and
  // writing a session row.
  if (mode === 'check') {
    const results: Record<string, boolean> = {};
    for (const pw of (process.env.E2E_SEC_PASSWORDS || '').split('\n').filter(Boolean)) {
      results[pw] = user.passwordHash ? await verifyPassword(user.passwordHash, pw) : false;
    }
    console.log(JSON.stringify({ hasPassword: !!user.passwordHash, matches: results }, null, 2));
    return;
  }

  if (mode === 'restore') {
    // A password hash is full of `$`, which is exactly what a shell likes to
    // expand, so the snapshot is normally handed back as the file it was
    // printed to rather than as environment variables.
    const saved = process.env.E2E_SEC_SNAPSHOT
      ? JSON.parse(readFileSync(process.env.E2E_SEC_SNAPSHOT, 'utf8').split('\n').filter((line) => !line.startsWith('[DB-POOL]') && !line.startsWith('npm warn')).join('\n'))
      : {};
    const since = process.env.E2E_SEC_SINCE || saved.since;
    const beforeHash = process.env.E2E_SEC_HASH || saved.passwordHash;
    const mustChange = process.env.E2E_SEC_MUST_CHANGE
      ?? (saved.mustChangePassword === undefined ? undefined : String(saved.mustChangePassword));
    const sessions = JSON.parse(process.env.E2E_SEC_SESSIONS || JSON.stringify(saved.sessions || []));
    if (!since) throw new Error('E2E_SEC_SINCE is required — restore cannot tell my rows from the seeded ones without it');

    const password = beforeHash
      ? await prisma.user.update({
          where: { id: user.id },
          data: {
            passwordHash: beforeHash,
            // The real change flips this to false; put back whatever was there.
            ...(mustChange === 'true' || mustChange === 'false' ? { mustChangePassword: mustChange === 'true' } : {}) } })
      : null;

    // Re-insert the sessions the password change signed out, ids and all.
    for (const row of sessions) {
      if (await prisma.userSession.findUnique({ where: { id: row.id } })) continue;
      const { id, ...rest } = row;
      await prisma.userSession.create({ data: { id, ...rest } as any });
    }

    const [events, notifs, otps, emails, signedIn, deliveries] = await Promise.all([
      prisma.activityEvent.deleteMany({
        where: { userId: user.id, createdAt: { gte: new Date(since) }, OR: [{ kind: { contains: 'password', mode: 'insensitive' } }, { kind: { contains: 'recovery', mode: 'insensitive' } }, { kind: { contains: 'export', mode: 'insensitive' } }] } }),
      prisma.notification.deleteMany({ where: { userId: user.id, createdAt: { gte: new Date(since) } } }),
      prisma.otp.deleteMany({ where: { userId: user.id, createdAt: { gte: new Date(since) } } }),
      prisma.userEmail.deleteMany({ where: { userId: user.id, kind: { in: ['recovery', 'secondary'] } } }),
      // Sign-ins the run made to prove the rotated password work. The rows it
      // found already there are older than `since`, so they are left alone.
      prisma.userSession.deleteMany({ where: { userId: user.id, createdAt: { gte: new Date(since) } } }),
      // An export notices the person by mail, so a test download leaves a delivery row.
      prisma.email_deliveries.deleteMany({ where: { userId: user.id, createdAt: { gte: new Date(since) } } }),
    ]);

    const after = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        passwordHash: true,
        sessions: { select: { id: true, status: true } },
        emails: { select: { address: true, kind: true, verifiedAt: true } },
        activityEvents: { where: { OR: [{ kind: { contains: 'password' } }, { kind: { contains: 'recovery' } }, { kind: { contains: 'export' } }] }, select: { kind: true } },
        notifications: { select: { id: true } } } });

    console.log(JSON.stringify({
      hashRestored: password?.passwordHash === beforeHash,
      deleted: {
        events: events.count,
        notifications: notifs.count,
        otps: otps.count,
        recoveryEmails: emails.count,
        deliveries: deliveries.count },
      sessionsNow: after?.sessions.length,
      emailsNow: after?.emails,
      securityEventsNow: after?.activityEvents.map((e) => e.kind),
      notificationsNow: after?.notifications.length,
      deliveriesNow: await prisma.email_deliveries.count({ where: { userId: user.id, createdAt: { gte: new Date(since) } } }) }, null, 2));
    return;
  }

  const [sessions, events, notifs, otps, emails] = await Promise.all([
    prisma.userSession.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
    prisma.activityEvent.findMany({
      where: { userId: user.id, OR: [{ kind: { contains: 'password', mode: 'insensitive' } }, { kind: { contains: 'recovery', mode: 'insensitive' } }] },
      select: { id: true, kind: true, createdAt: true } }),
    prisma.notification.findMany({ where: { userId: user.id }, select: { id: true, title: true } }),
    prisma.otp.findMany({ where: { userId: user.id }, select: { id: true, kind: true } }),
    prisma.userEmail.findMany({ where: { userId: user.id }, select: { address: true, kind: true, verifiedAt: true } }),
  ]);

  console.log(JSON.stringify({
    userId: user.id,
    since: new Date().toISOString(),
    passwordHash: user.passwordHash,
    mustChangePassword: user.mustChangePassword,
    hasPassword: !!user.passwordHash,
    sessions,
    events,
    notifications: notifs.length,
    otps,
    emails }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(0));
