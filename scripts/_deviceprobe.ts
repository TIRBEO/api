import { prisma } from '@/infrastructure/db/prisma';
import { createSession, generateCsrfToken, revokeSession } from '@/features/auth/session';

/* Live probe of the five new device/sign-in reads, run against the dev API as a
   real operator with a session minted and revoked inside this process.
   Nothing here ends a live session: the write path is exercised against a row
   that is already revoked (409) and with no id at all (400). */

const API = process.env.SMOKE_API_ORIGIN ?? 'http://localhost:3000';

async function get(path: string, token: string) {
  const res = await fetch(`${API}${path}`, {
    headers: { cookie: `__session=${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(45_000),
  });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

function summary(path: string, status: number, body: any): string {
  if (status !== 200) return `${path.padEnd(34)} ${status} ${JSON.stringify(body?.error ?? body).slice(0, 120)}`;
  if (!body || typeof body !== 'object') return `${path.padEnd(34)} ${status} (no body)`;
  if (Array.isArray(body.rows)) {
    const keys = Object.keys(body.rows[0] ?? {}).join(',');
    return `${path.padEnd(34)} ${status} total=${body.total} rows=${body.rows.length} [${keys}]`;
  }
  return `${path.padEnd(34)} ${status} ${JSON.stringify(body).slice(0, 170)}`;
}

/** The leak test: no field name in any response may be a stored secret. */
const FORBIDDEN = ['tokenhash', 'token_hash', 'p256dh', 'endpoint', 'credentialpubkey', 'pubkey', 'totpsecret', 'passwordhash'];

function assertNoSecrets(path: string, value: unknown, seen = new Set<unknown>()): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const hits: string[] = [];
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN.includes(key.toLowerCase())) hits.push(`${path} -> ${key}`);
    hits.push(...assertNoSecrets(path, inner, seen));
  }
  return hits;
}

/** The probe's own session, so the cleanup at the end can always find it. */
let probeSession: string | null = null;

async function main() {
  const operator = await prisma.user.findFirst({
    where: { isAdmin: true, status: 'active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true },
  });
  if (!operator) throw new Error('no staff account to mint for');

  const { token, sessionId } = await createSession(
    operator.id,
    'Mozilla/5.0 (X11; Linux x86_64) device read probe',
    '127.0.0.1',
  );
  probeSession = sessionId;
  console.log(`operator ${operator.email}  probe session ${sessionId.slice(0, 8)}`);

  const paths = [
    '/api/admin/devices/summary',
    '/api/admin/devices?limit=3',
    '/api/admin/sessions?live=1&limit=3',
    '/api/admin/sessions?live=0&limit=3',
    '/api/admin/push?limit=3',
    '/api/admin/passkeys?limit=3',
    '/api/admin/sign-ins?limit=3',
    '/api/admin/sign-ins?success=false&limit=3',
    '/api/admin/sign-ins?from=2026-10-01&to=2026-10-23&limit=3',
    '/api/admin/devices?q=birga&limit=3',
    '/api/admin/sign-ins?from=nonsense',
  ];

  const leaks: string[] = [];
  for (const path of paths) {
    const { status, body } = await get(path, token);
    console.log(summary(path, status, body));
    if (status === 200) leaks.push(...assertNoSecrets(path, body));
  }
  console.log(leaks.length ? `SECRET LEAKS: ${leaks.join(', ')}` : 'no secret field in any response');

  const dead = await prisma.userSession.findFirst({
    where: { revokedAt: { not: null } },
    orderBy: { revokedAt: 'desc' },
    select: { id: true },
  });
  /* The guard is double-submit, not a secret the client cannot know: the token
     is a random string the caller holds in a cookie and echoes in a header.
     Minting a matching pair here is exactly what a browser does on a write. */
  const csrf = generateCsrfToken();
  const post = async (body: unknown) => {
    const res = await fetch(`${API}/api/admin/sessions`, {
      method: 'POST',
      headers: {
        cookie: `__session=${token}; __csrf=${csrf}`,
        'x-csrf-token': csrf,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const noId = await post({});
  console.log(`POST revoke, no id            -> ${noId.status} ${JSON.stringify(noId.body).slice(0, 90)}`);
  if (dead) {
    const twice = await post({ sessionId: dead.id });
    console.log(`POST revoke, already ended    -> ${twice.status} ${JSON.stringify(twice.body).slice(0, 90)}`);
  }
  const ghost = await post({ sessionId: 'no-such-session-id' });
  console.log(`POST revoke, unknown id       -> ${ghost.status} ${JSON.stringify(ghost.body).slice(0, 90)}`);

  // The probe's own session, revoked through the ordinary door — the only live
  // row this script is allowed to end is the one it made for itself.
  const mine = await post({ sessionId });
  console.log(`POST revoke, this probe itself-> ${mine.status} ${JSON.stringify(mine.body).slice(0, 90)}`);

  const stillIn = await get('/api/admin/devices/summary', token);
  console.log(`same token after revoke       -> ${stillIn.status} (must be 401)`);
}

main().finally(async () => {
  // Idempotent: if the last step already ended it through the endpoint, this
  // finds nothing to do. If the script threw earlier, it never leaves a live
  // session behind.
  if (probeSession) await revokeSession(probeSession);
  process.exit(0);
});
