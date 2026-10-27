import { prisma } from '@/infrastructure/db/prisma';
import { createSession, revokeSession } from '@/features/auth/session';

/* Do the new device/sign-in screens show the platform's own rows, or a plate
   that says they could not be read? A 200 answers neither question, so this
   fetches each page as a real operator and looks for the markers that prove the
   data arrived: a figure that only the database can supply, a place name from a
   stored row, and the absence of the failure plate. */

const ADMIN = process.env.SMOKE_ADMIN_ORIGIN ?? 'http://localhost:4000';

const CHECKS: Array<{ path: string; expect: string[] }> = [
  { path: '/admin/resources/devices', expect: ['Live sessions', 'Push subscriptions'] },
  { path: '/admin/resources/browsers', expect: ['Reached from', 'Birga'] },
  { path: '/admin/resources/sessions', expect: ['Signed in', 'live'] },
  { path: '/admin/resources/push', expect: ['No records found'] },
  { path: '/admin/resources/passkeys', expect: ['No records found'] },
  { path: '/admin/reports/sign-ins', expect: ['By method', 'Refused'] },
  { path: '/admin/reports/sign-in-activity', expect: ['Attempts', 'Doors in use'] },
];

const BAD_MARKERS = ['This screen could not load', 'The API never answered', 'Application error'];

/** The probe's own session, so the cleanup always finds it. */
let probeSession: string | null = null;

async function main() {
  const operator = await prisma.user.findFirst({
    where: { isAdmin: true, status: 'active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true },
  });
  if (!operator) throw new Error('no staff account to mint for');

  const { token, sessionId } = await createSession(operator.id, 'Mozilla/5.0 page content probe', '127.0.0.1');
  probeSession = sessionId;
  console.log(`operator ${operator.email}`);

  let failures = 0;
  for (const check of CHECKS) {
    const res = await fetch(`${ADMIN}${check.path}`, {
      headers: { cookie: `__session=${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    const html = await res.text();
    const missing = check.expect.filter((needle) => !html.includes(needle));
    const bad = BAD_MARKERS.filter((needle) => html.includes(needle));
    const ok = res.status === 200 && !missing.length && !bad.length;
    if (!ok) failures += 1;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${check.path.padEnd(30)} ${res.status}` +
        (missing.length ? ` missing: ${missing.join(', ')}` : '') +
        (bad.length ? ` plate: ${bad.join(', ')}` : '') +
        // The count sentence the page writes about itself, as the DB sees it.
        ` (${(html.match(/\d+ row[s]? match/) ?? ['no row count'])[0]})`,
    );
  }
  console.log(failures ? `${failures} screen(s) not showing real data` : 'every new screen reads real data');
}

main().finally(async () => {
  if (probeSession) await revokeSession(probeSession);
  process.exit(0);
});
