/**
 * A deterministic dataset for the scratch database, and nothing else.
 *
 *   npx tsx --env-file=.env.scratch scripts/scratch-fixture.ts
 *   npx tsx --env-file=.env.scratch scripts/scratch-fixture.ts --purge
 *
 * Three reasons this exists rather than pointing the browser tests at the real
 * database: the console's rows have to be *known* for a filter, a sort and a
 * screenshot to be asserted against; the mutating scenarios suspend, ban and
 * delete accounts, which must never happen to a person; and every address here
 * is under `.test`, a reserved TLD nothing delivers to, so a misconfigured
 * transport cannot mail a real reader even in principle.
 *
 * Deterministic in the way that matters: a seeded generator, the same names, the
 * same statuses, and timestamps anchored to the top of the current UTC hour so
 * two runs in the same hour produce byte-identical relative times. Re-run this
 * before a visual comparison if the hour has turned.
 *
 * Idempotent: it deletes its own namespace first, and touches no row outside it.
 */
import { prisma } from '@/infrastructure/db/prisma';
import * as argon2 from 'argon2';

const DOMAIN = 'scratch.tirbeo.test';
const purging = process.argv.includes('--purge');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Anchored, not `Date.now()`: a fixture that drifts makes every relative
 *  timestamp in the console drift with it, and a screenshot baseline cannot
 *  agree with a row that moves. */
const ANCHOR = (() => {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d;
})();
const ago = (ms: number) => new Date(ANCHOR.getTime() - ms);

/** mulberry32. A fixed seed, so run 7 and run 8 are the same platform. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261024);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length) % xs.length];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const FIRST = ['Abebe', 'Almaz', 'Bikash', 'Sabin', 'Nirmala', 'Prakash', 'Sushila', 'Kiran', 'Rojina', 'Dipesh', 'Anjali', 'Manoj', 'Pooja', 'Rabin', 'Sarita', 'Hari', 'Gita', 'Tilak', 'Bimala', 'Krishna'];
const LAST = ['Shah', 'Maharjan', 'Manandhar', 'Karki', 'Shrestha', 'Tadse', 'Gurung', 'Rai', 'Limbu', 'Thapa', 'Bhattarai', 'Poudel', 'Adhikari', 'Basnet', 'Chaudhary'];
const CITIES = ['Kathmandu', 'Lalitpur', 'Bhaktapur', 'Pokhara', 'Chitwan', 'Butwal', 'Biratnagar', 'Dharan'];
const AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
];
const DEVICE_NAMES = ['Windows PC', 'MacBook Pro', 'Pixel 9', 'iPhone 15', 'Linux Desktop'];
const STATUSES = ['active', 'active', 'active', 'active', 'restricted', 'suspended', 'banned', 'deactivated', 'deletion_pending'] as const;

const ip = () => `${int(27, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, '');
let sequence = 0;

async function account(input: {
  first: string;
  last: string;
  status: (typeof STATUSES)[number];
  email?: string;
  username?: string;
  password?: string;
  isAdmin?: boolean;
}) {
  const name = `${input.first} ${input.last}`;
  // A sequence, not a random suffix: `email` and `username` are both unique, and
  // 47 draws from a 90-value space collide often enough to abort the seed half
  // way through — which is a bad way to discover this on a machine that is
  // supposed to be reproducible.
  const n = ++sequence;
  const email = input.email ?? `${slug(input.first)}.${slug(input.last)}${n}@${DOMAIN}`;
  const username = input.username ?? `${slug(input.first)}${slug(input.last)}${n}`;
  const createdDaysAgo = int(3, 240) * DAY;
  // An account that stopped signing in is more interesting than one that is
  // always fresh: the console sorts, filters and ages rows on this column.
  const lastActiveMs = input.status === 'active' ? int(1, 90) * MIN : int(2, 60) * DAY;
  const hash = input.password
    ? await argon2.hash(input.password, { type: argon2.argon2id, memoryCost: 2 ** 16, timeCost: 3, parallelism: 1 })
    : '';

  const user = await prisma.user.create({
    data: {
      email,
      username,
      passwordHash: hash,
      status: input.status,
      isAdmin: input.isAdmin ?? false,
      createdAt: ago(createdDaysAgo),
      lastLoginAt: ago(lastActiveMs),
      lastActiveAt: ago(lastActiveMs),
      profile: { create: { name, bio: rand() < 0.4 ? 'Testing the console end to end.' : null } },
      preferences: {
        create: {
          appearance: { theme: pick(['light', 'dark', 'system']), timezone: 'Asia/Kathmandu', language: 'ne' },
          notif: { email: rand() < 0.7, push: rand() < 0.4 },
          privacy: { whoCanFindMe: 'contacts', showEmail: rand() < 0.5 },
          misc: { consents: { analytics: true, personalization: rand() < 0.5 } },
        },
      },
      emails: {
        create: [
          { address: email, kind: 'primary', isDefault: true, verifiedAt: ago(createdDaysAgo - HOUR) },
          ...(rand() < 0.25
            // A second address under .test as well. A recovery address on a real
            // domain is one misconfigured transport away from mailing a stranger.
            ? [{ address: `${slug(input.first)}.${slug(input.last)}.recovery@${DOMAIN}`, kind: 'recovery', verifiedAt: ago(int(1, 80) * DAY) }]
            : []),
        ],
      },
      security: {
        create: {
          totpEnabled: rand() < 0.2,
          require2FA: rand() < 0.05,
          mustChangePw: rand() < 0.05,
          backupCodes: rand() < 0.3 ? [] : [{ code: 'scratch-placeholder', usedAt: null }],
        },
      },
      ...(rand() < 0.5 ? { phone: { create: { number: `+9779${int(10000000, 19999999)}`, verifiedAt: ago(int(1, 100) * DAY) } } } : {}),
    },
    select: { id: true, email: true, username: true },
  });

  const rows = int(1, 4);
  for (let i = 0; i < rows; i++) {
    const signedInAgo = int(1, 30) * DAY;
    const revoked = rand() < 0.25;
    const expired = !revoked && rand() < 0.2;
    await prisma.userSession.create({
      data: {
        userId: user.id,
        tokenHash: `scratch-${user.id}-${i}-${Math.floor(rand() * 1e9)}`,
        status: revoked ? 'revoked' : expired ? 'expired' : 'active',
        ipAddress: ip(),
        userAgent: pick(AGENTS),
        deviceName: pick(DEVICE_NAMES),
        location: `${pick(CITIES)}, Nepal`,
        createdAt: ago(signedInAgo),
        lastUsedAt: ago(Math.min(signedInAgo, int(1, 400) * MIN)),
        expiresAt: expired ? ago(int(1, 20) * HOUR) : ago(-30 * DAY),
        revokedAt: revoked ? ago(int(1, 10) * DAY) : null,
      },
    });
    if (rand() < 0.7) {
      const agent = pick(AGENTS);
      await prisma.userDevice.create({
        data: {
          userId: user.id,
          deviceName: agent.split(')')[0]?.split('(')[1]?.trim().slice(0, 60) ?? pick(DEVICE_NAMES),
          userAgent: agent,
          ipAddress: ip(),
          location: `${pick(CITIES)}, Nepal`,
          status: rand() < 0.15 ? 'revoked' : 'active',
          createdAt: ago(signedInAgo),
          lastUsedAt: ago(int(1, 500) * MIN),
        },
      });
    }
    for (let l = 0; l < int(1, 3); l++) {
      await prisma.userLogin.create({
        data: {
          userId: user.id,
          method: pick(['password', 'password', 'passkey', 'google', 'magic']),
          success: rand() < 0.9,
          ipAddress: ip(),
          userAgent: pick(AGENTS),
          location: `${pick(CITIES)}, Nepal`,
          createdAt: ago(int(1, 45) * DAY),
        },
      });
    }
  }

  for (let a = 0; a < int(1, 6); a++) {
    await prisma.activityEvent.create({
      data: {
        userId: user.id,
        kind: pick(['profile.updated', 'password.reset', 'totp.enabled', 'session.revoked', 'data.exported', 'settings.updated', 'user.login']),
        title: pick(['Profile updated', 'Password reset', 'Two-factor enabled', 'A session was revoked', 'Data exported', 'Settings updated', 'Signed in']),
        detail: `account:${user.id}`,
        severity: pick(['info', 'info', 'info', 'warning']),
        ipAddress: ip(),
        userAgent: pick(AGENTS),
        metadata: { targetType: 'user', targetId: user.id },
        createdAt: ago(int(1, 40) * DAY),
      },
    });
  }

  for (let n = 0; n < int(0, 4); n++) {
    await prisma.notification.create({
      data: {
        userId: user.id,
        type: pick(['announcement', 'security', 'message', 'system']),
        title: pick(['A new announcement', 'Check your sign-ins', 'Someone mentioned you', 'Verification received']),
        body: 'Scratch fixture row — not a real notice.',
        link: '/notifications',
        isRead: rand() < 0.5,
        createdAt: ago(int(1, 25) * DAY),
      },
    });
  }

  if (input.status !== 'active') {
    await prisma.userStatusEvent.create({
      data: {
        userId: user.id,
        fromStatus: 'active',
        toStatus: input.status,
        reason: pick(['Spam from a new range', 'Impersonation report upheld', 'Requested by the account', 'Repeated guideline strikes']),
        actor: input.status === 'deactivated' || input.status === 'deletion_pending' ? 'user' : 'admin',
        metadata: { note: 'scratch fixture' },
        createdAt: ago(int(1, 30) * DAY),
      },
    });
  }

  if (rand() < 0.12) {
    const restriction = await prisma.userRestriction.create({
      data: {
        userId: user.id,
        guideline: pick(['harassment', 'spam', 'impersonation', 'nsfw']),
        title: pick(['Harassment policy', 'Spam and solicitation', 'Impersonation policy', 'Adult content policy']),
        detail: 'Scratch fixture restriction.',
        severity: pick(['notice', 'warning', 'strike']),
        startedAt: ago(int(2, 40) * DAY),
        endsAt: rand() < 0.5 ? ago(-int(1, 30) * DAY) : null,
      },
      select: { id: true },
    });
    if (rand() < 0.6) {
      await prisma.userAppeal.create({
        data: {
          restrictionId: restriction.id,
          userId: user.id,
          note: 'I believe this was automated and wrong.',
          decision: rand() < 0.5 ? pick(['upheld', 'overturned']) : null,
          decidedAt: rand() < 0.5 ? ago(int(1, 10) * DAY) : null,
          createdAt: ago(int(1, 20) * DAY),
        },
      });
    }
  }

  if (input.status === 'deletion_pending') {
    await prisma.userDeletionRequest.create({
      data: { userId: user.id, reason: 'Leaving the platform', requestedAt: ago(int(1, 20) * DAY), finalAt: ago(-int(3, 25) * DAY) },
    });
  }

  if (rand() < 0.1) {
    await prisma.dataExportRequest.create({
      data: {
        userId: user.id,
        format: pick(['json', 'html']),
        status: pick(['ready', 'ready', 'pending', 'failed']),
        fileName: `tirbeo-${username}.zip`,
        bytes: int(20_000, 900_000),
        counts: { posts: int(3, 400), comments: int(0, 90) },
        requestedAt: ago(int(1, 30) * DAY),
        builtAt: ago(int(1, 29) * DAY),
      },
    });
  }

  if (rand() < 0.4) {
    await prisma.email_jobs.create({
      data: {
        userId: user.id,
        eventKey: pick(['welcome', 'verify_email', 'password_reset', 'suspicious_login']),
        toEmail: user.email,
        toAddress: name,
        category: pick(['transactional', 'security', 'notification']),
        kind: pick(['notice', 'verify', 'reset', 'digest']),
        subject: 'Scratch fixture mail',
        status: pick(['sent', 'sent', 'delivered', 'failed', 'queued']),
        attempts: 1,
        createdAt: ago(int(1, 30) * DAY),
        sentAt: ago(int(1, 29) * DAY),
      },
    });
    await prisma.email_deliveries.create({
      data: {
        userId: user.id,
        toEmail: user.email,
        eventKey: 'welcome',
        event: 'Welcome to Tirbeo',
        category: 'transactional',
        subject: 'Scratch fixture mail',
        status: pick(['sent', 'delivered', 'opened', 'bounced']),
        provider: 'none',
        createdAt: ago(int(1, 30) * DAY),
        openedAt: rand() < 0.5 ? ago(int(1, 20) * DAY) : null,
      },
    });
  }

  if (rand() < 0.15) {
    await prisma.pushSubscription.create({
      data: {
        userId: user.id,
        endpoint: `https://scratch.push.example/${user.id}-${Math.floor(rand() * 1e6)}`,
        p256dh: Buffer.from(`scratch-p256dh-${user.id}`).toString('base64url'),
        auth: Buffer.from(`scratch-auth-${user.id}`).toString('base64url'),
        userAgent: pick(AGENTS),
        createdAt: ago(int(1, 60) * DAY),
        lastUsedAt: ago(int(1, 10) * DAY),
      },
    });
  }

  return user;
}

/** The five roles the catalogue knows, so a permission-filtered rail can be
 *  asserted against a role that actually sees something different. */
const OPERATORS = [
  { role: 'owner', first: 'Owner', last: 'Consola', email: `owner@${DOMAIN}`, username: 'scratchowner' },
  { role: 'admin', first: 'Admin', last: 'Consola', email: `admin@${DOMAIN}`, username: 'scratchadmin' },
  { role: 'moderator', first: 'Moderator', last: 'Consola', email: `moderator@${DOMAIN}`, username: 'scratchmod' },
  { role: 'support', first: 'Support', last: 'Consola', email: `support@${DOMAIN}`, username: 'scratchsupport' },
  { role: 'analyst', first: 'Analyst', last: 'Consola', email: `analyst@${DOMAIN}`, username: 'scratchanalyst' },
];

async function main() {
  const existing = await prisma.user.findMany({ where: { email: { endsWith: `@${DOMAIN}` } }, select: { id: true } });
  if (existing.length) {
    // Cascade takes the profile, sessions, devices, activity and everything else
    // that hangs off an account in this namespace.
    await prisma.user.deleteMany({ where: { id: { in: existing.map((e) => e.id) } } });
  }
  await prisma.blocklist.deleteMany({ where: { targetId: { startsWith: 'scratch:' } } });
  await prisma.securityEvent.deleteMany({ where: { eventType: { startsWith: 'scratch.' } } });
  await prisma.activityEvent.deleteMany({ where: { title: 'Scratch audit row' } });
  if (purging) {
    await prisma.appConfig.deleteMany({ where: { key: { startsWith: 'scratch.' } } });
    // Fixed-window counters, not the thresholds. `verification_limits` rows are
    // configuration that /admin/verification-limits edits, and a fixture that
    // deleted them would quietly raise or lower the platform's lockout rules;
    // what a re-run needs is the *counters* its own sign-ins filled up, scoped to
    // the addresses it owns.
    await prisma.rateLimitWindow.deleteMany({ where: { key: { contains: DOMAIN } } });
  }
  console.log(`purged ${existing.length} prior fixture accounts`);

  for (const op of OPERATORS) {
    const user = await account({
      first: op.first,
      last: op.last,
      email: op.email,
      username: op.username,
      password: 'Scratch!Operator!42',
      status: 'active',
      isAdmin: op.role === 'owner' || op.role === 'admin',
    });
    await prisma.staffRole.create({ data: { userId: user.id, role: op.role, note: 'scratch fixture' } });
  }
  console.log(`${OPERATORS.length} operators, one per role, password Scratch!Operator!42`);

  const people: { id: string; email: string }[] = [];
  for (let i = 0; i < 42; i++) {
    people.push(await account({ first: pick(FIRST), last: pick(LAST), status: pick(STATUSES) }));
  }
  console.log(`42 accounts across ${new Set(STATUSES).size} statuses`);

  /* The trail an operator reads at /admin/security/audit: admin verbs with an
     actor and a target, written the way the code that writes them writes them. */
  const actions = ['admin.session_revoked', 'user.suspended', 'user.banned', 'staff.role.granted', 'settings.updated', 'data.exported', 'appeal.decided', 'blocklist.added'];
  for (let i = 0; i < 60; i++) {
    const target = pick(people);
    await prisma.activityEvent.create({
      data: {
        userId: target.id,
        kind: pick(actions),
        title: 'Scratch audit row',
        detail: `user:${target.id}`,
        severity: pick(['info', 'info', 'warning', 'critical']),
        ipAddress: ip(),
        userAgent: pick(AGENTS),
        metadata: {
          targetType: 'user',
          targetId: target.id,
          reason: pick(['Spam from a new range', 'Impersonation report upheld', 'Requested by the account', 'Repeated guideline strikes']),
        },
        createdAt: ago(int(1, 45) * DAY),
      },
    });
  }

  for (let i = 0; i < 24; i++) {
    await prisma.securityEvent.create({
      data: {
        userId: pick(people).id,
        eventType: pick(['scratch.login_failed', 'scratch.new_device', 'scratch.password_reset', 'scratch.totp_challenge_failed']),
        severity: pick(['info', 'warning', 'critical']),
        ipAddress: ip(),
        userAgent: pick(AGENTS),
        metadata: { location: `${pick(CITIES)}, Nepal` },
        createdAt: ago(int(1, 30) * DAY),
      },
    });
  }

  for (let i = 0; i < 6; i++) {
    await prisma.blocklist.create({
      data: {
        targetType: pick(['email', 'domain', 'phone']),
        targetId: `scratch:${pick(['mail-spam.example', 'throwaway.example', 'plus9779800000', 'blocked-handle'])}${i}`,
        reason: pick(['Bulk signups from this domain', 'Reported spam', 'Abuse from this number']),
        isActive: rand() < 0.8,
        expiresAt: rand() < 0.3 ? ago(-int(1, 30) * DAY) : null,
        createdAt: ago(int(1, 60) * DAY),
      },
    });
  }

  for (const [method, max, windowMs] of [
    ['email', 5, 15 * MIN],
    ['phone', 3, 10 * MIN],
    ['totp', 5, 5 * MIN],
  ] as const) {
    await prisma.verificationLimit.upsert({
      where: { method },
      create: { method, max, windowMs },
      update: { max, windowMs },
    });
  }

  /* A couple of AppConfig rows, because the system screens read them and a
     missing key is a different screen from an empty one. */
  await prisma.appConfig.upsert({
    where: { key: 'scratch.flag' },
    create: { key: 'scratch.flag', value: { enabled: true }, description: 'Scratch fixture config row' },
    update: { value: { enabled: true } },
  });

  console.log(
    JSON.stringify({
      accounts: await prisma.user.count({ where: { email: { endsWith: `@${DOMAIN}` } } }),
      sessions: await prisma.userSession.count(),
      devices: await prisma.userDevice.count(),
      logins: await prisma.userLogin.count(),
      activity: await prisma.activityEvent.count(),
      notifications: await prisma.notification.count(),
      appeals: await prisma.userAppeal.count(),
      deliveries: await prisma.email_deliveries.count(),
    }),
  );
}

void main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
    /* The pool keeps warm connections on a timer, so a seed that finished its
       work would otherwise sit here forever. Nothing is left to flush. */
    process.exit(0);
  });
