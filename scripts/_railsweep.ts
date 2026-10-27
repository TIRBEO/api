import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/infrastructure/db/prisma';
import { createSession, revokeSession } from '@/features/auth/session';

/* Local-only smoke pass: every rail address in apps/admin/lib/nav.ts, fetched
   from the running dev server as a real staff operator, with the session minted
   and revoked inside this process so the token never leaves it. */

const ADMIN = process.env.SMOKE_ADMIN_ORIGIN ?? 'http://localhost:4000';
const NAV_FILE = join(process.cwd(), '..', 'admin', 'lib', 'nav.ts');

/** The leaf addresses the rail can send anybody to. Dynamic ones (`[id]`) are
    skipped here — they need a record, and the screens that carry them were
    checked by hand. */
function railAddresses(): string[] {
  const source = readFileSync(NAV_FILE, 'utf8');
  const found = [...source.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(found)]
    .filter((href) => href.startsWith('/admin'))
    .filter((href) => !href.includes('['))
    .sort();
}

const FAIL_MARKERS = [
  'Application error',
  'Unhandled Runtime Error',
  'Internal Server Error',
  'Page not found',
  'This page could not be found',
  'missing required error components',
];

async function main() {
  const operator = await prisma.user.findFirst({
    where: { isAdmin: true, status: 'active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, username: true },
  });
  if (!operator) throw new Error('no staff account to mint for');
  console.log(`operator: ${operator.username ?? operator.email}`);

  const { token, sessionId } = await createSession(
    operator.id,
    'Mozilla/5.0 (X11; Linux x86_64) SMOKE',
    '127.0.0.1',
  );

  const addresses = railAddresses();
  console.log(`${addresses.length} rail addresses`);
  const bad: string[] = [];
  try {
    for (const href of addresses) {
      let line: string;
      try {
        const res = await fetch(`${ADMIN}${href}`, {
          headers: { Cookie: `__session=${token}`, 'x-smoke': '1' },
          redirect: 'manual',
          signal: AbortSignal.timeout(45_000),
        });
        const status = res.status;
        const location = res.headers.get('location') ?? '';
        const body = status === 200 ? await res.text() : '';
        const marker = FAIL_MARKERS.find((m) => body.includes(m));
        line = `${status}${location ? ` -> ${location}` : ''}${marker ? ` !! ${marker}` : ''}`;
        if (status !== 200 || marker) bad.push(`${href} ${line}`);
      } catch (err: any) {
        line = `THREW ${err?.message || err}`;
        bad.push(`${href} ${line}`);
      }
      console.log(`${href.padEnd(52)} ${line}`);
    }
  } finally {
    await revokeSession(sessionId).catch(() => {});
    console.log('(session revoked)');
  }

  console.log(bad.length ? `\nFAILED ${bad.length}:\n${bad.join('\n')}` : `\nALL ${addresses.length} OK`);
}

main()
  .catch((err) => { console.error('[SMOKE]', err?.message || err); process.exitCode = 1; })
  .finally(() => process.exit(0));
