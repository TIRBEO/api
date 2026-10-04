/**
 * Seed a real authenticated test account for Phase E data-tranche verification.
 *
 * It provisions one test user with realistic rows across every table the
 * myprofile data pages read (sessions, devices, login history, activity, an
 * OAuth connection, security/backup-code state), then mints a long-lived
 * __session JWT so the slices can be exercised over HTTP without re-running
 * the gated signup flow.
 *
 *   npx tsx --env-file=.env.local scripts/e2e-data-seed.ts            # seed + mint
 *   npx tsx --env-file=.env.local scripts/e2e-data-seed.ts --cleanup   # delete test user
 *
 * Outputs (userId, sessionId, token, password) are written to /tmp so the repo
 * never sees a live bearer token. Idempotent: each run deletes the prior test
 * user (cascades its rows) and recreates a clean, known set.
 */
import { prisma } from '@/infrastructure/db/prisma';
import { SignJWT } from 'jose';
import * as argon2 from 'argon2';
import crypto from 'node:crypto';
import fs from 'node:fs';

const EMAIL = 'e2e.datauser@gmail.com';
const USERNAME = 'e2edatauser';
const NAME = 'E2E Data Tester';
const PASSWORD = 'E2eDataTest!42';
const OUT = '/tmp/tirbeo-e2e.env';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const hex = (n: number) => Buffer.from(crypto.randomBytes(n)).toString('hex');

// [userAgent, ip, location, signedInOffsetAgo, lastActiveOffsetAgo]
const SESSIONS: [string, string, string, number, number][] = [
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', '202.79.160.14', 'Kathmandu, Nepal', 2 * HOUR, 3 * MIN],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', '103.181.81.44', 'Lalitpur, Nepal', 9 * HOUR, 40 * MIN],
  ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', '45.127.88.3', 'Bhaktapur, Nepal', 3 * DAY, 2 * DAY],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15', '116.212.101.8', 'Pokhara, Nepal', 12 * DAY, 6 * DAY],
];

const deviceName = (ua: string) => ua.split(')')[0]?.split('(')[1]?.trim().slice(0, 120) || null;

async function seed() {
  // Start clean — deleting the user cascades sessions, devices, logins, activity.
  const existing = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (existing) await prisma.user.delete({ where: { id: existing.id } });

  const passwordHash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id, memoryCost: 2 ** 16, timeCost: 3, parallelism: 1,
  });

  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      username: USERNAME,
      name: NAME,
      passwordHash,
      emailVerified: true,
      status: 'active',
      language: 'en',
      theme: 'system',
      githubId: 'gh-e2e-12345', // makes /integrations GET report github connected
    },
    select: { id: true, email: true, username: true },
  });
  const uid = user.id;

  await prisma.userEmail.create({
    data: { userId: uid, address: EMAIL, kind: 'primary', isDefault: true, verifiedAt: new Date() },
  });

  // Security row starts with 2FA off and no backup codes (regenerate exercises it).
  await prisma.userSecurity.upsert({
    where: { userId: uid },
    create: { userId: uid, totpEnabled: false, backupCodes: [] },
    update: { totpEnabled: false, backupCodes: [] },
  });

  // Sessions + matching device registry rows. First entry is "current".
  const now = Date.now();
  let currentSessionId = '';
  for (let i = 0; i < SESSIONS.length; i++) {
    const [ua, ip, location, signedInAgo, activeAgo] = SESSIONS[i];
    const createdAt = new Date(now - signedInAgo - DAY);
    const lastUsedAt = new Date(now - activeAgo);
    const s = await prisma.userSession.create({
      data: {
        userId: uid,
        tokenHash: hex(32),
        status: 'active',
        ipAddress: ip,
        userAgent: ua,
        deviceName: deviceName(ua),
        location,
        createdAt,
        lastUsedAt,
        expiresAt: new Date(now + 30 * DAY),
        revokedAt: null,
      },
      select: { id: true },
    });
    if (i === 0) currentSessionId = s.id;
    await prisma.userDevice.create({
      data: { userId: uid, deviceName: deviceName(ua), userAgent: ua, ipAddress: ip, location, status: 'active', createdAt, lastUsedAt },
    });
  }

  // Login history (user_logins).
  const logins: [string, boolean, string, string, string, number][] = [
    ['password', true, '202.79.160.14', SESSIONS[0][0], 'Kathmandu, Nepal', 2 * HOUR],
    ['password', true, '103.181.81.44', SESSIONS[1][0], 'Lalitpur, Nepal', 9 * HOUR],
    ['google', true, '45.127.88.3', SESSIONS[2][0], 'Bhaktapur, Nepal', 3 * DAY],
    ['password', false, '182.93.200.11', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0', 'Unknown', 4 * DAY],
    ['password', true, '116.212.101.8', SESSIONS[3][0], 'Pokhara, Nepal', 12 * DAY],
    ['github', true, '202.79.160.14', SESSIONS[0][0], 'Kathmandu, Nepal', 20 * DAY],
  ];
  for (const [method, success, ip, ua, location, ago] of logins) {
    await prisma.userLogin.create({
      data: { userId: uid, method, success, ipAddress: ip, userAgent: ua, location, createdAt: new Date(now - ago) },
    });
  }

  // Activity feed (activity_events).
  const acts: [string, string, string | null, 'info' | 'warning' | 'error' | 'critical', number, string][] = [
    ['user.login', 'Signed in', 'password', 'info', 2 * HOUR, 'Kathmandu, Nepal'],
    ['security.2fa_enabled', 'Two-factor enabled', 'totp', 'warning', 5 * DAY, 'Kathmandu, Nepal'],
    ['password.changed', 'Password changed', null, 'warning', 7 * DAY, 'Kathmandu, Nepal'],
    ['profile.updated', 'Profile updated', 'name', 'info', 10 * DAY, 'Lalitpur, Nepal'],
    ['account.merge', 'Account merged', 'github', 'critical', 15 * DAY, 'Kathmandu, Nepal'],
    ['form.submitted', 'Form submitted', 'contact', 'info', 21 * DAY, 'Pokhara, Nepal'],
  ];
  for (const [kind, title, detail, severity, ago, location] of acts) {
    await prisma.activityEvent.create({
      data: { userId: uid, kind, title, detail, severity, ipAddress: '202.79.160.14', userAgent: SESSIONS[0][0], metadata: { location }, createdAt: new Date(now - ago) },
    });
  }

  // Long-lived access JWT (8h) so verification isn't cut off by the 15m production TTL.
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  const token = await new SignJWT({ sub: uid, sid: currentSessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(new TextEncoder().encode(secret));

  fs.writeFileSync(OUT, [
    `export E2E_USER_ID=${uid}`,
    `export E2E_SESSION_ID=${currentSessionId}`,
    `export E2E_EMAIL=${EMAIL}`,
    `export E2E_PASSWORD=${PASSWORD}`,
    `export E2E_TOKEN=${token}`,
    '',
  ].join('\n'), { mode: 0o600 });

  console.log('SEEDED');
  console.log(JSON.stringify({ userId: uid, sessionId: currentSessionId, email: EMAIL, out: OUT }, null, 2));
}

async function cleanup() {
  const u = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (u) {
    await prisma.user.delete({ where: { id: u.id } });
    console.log(`CLEANUP: deleted ${EMAIL} (${u.id})`);
  } else {
    console.log('CLEANUP: test user not present');
  }
  try { fs.rmSync(OUT); } catch { /* no file */ }
}

async function main() {
  if (process.argv.includes('--cleanup')) await cleanup();
  else await seed();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect?.().catch(() => {}); process.exit(); });
