import { prisma } from '@/infrastructure/db/prisma';
import { createSession, revokeSession } from '@/features/auth/session';

/* Local-only: mint a session for a staff account, read the admin support
   endpoints through the running dev server, then revoke it. The token never
   leaves this process — only the responses are printed. */

async function main() {
  const users = await prisma.user.findMany({
    where: { isAdmin: true },
    select: { id: true, email: true, username: true },
    take: 5,
  });
  console.log('staff candidates:', users.map((u) => u.username ?? u.email).join(', ') || 'none');

  const target = users[0]?.id ?? process.argv[2];
  if (!target) throw new Error('no staff account to mint for');

  const { token, sessionId } = await createSession(
    target,
    'Mozilla/5.0 (X11; Linux x86_64) local check',
    '127.0.0.1',
  );

  const call = async (path: string) => {
    const res = await fetch(`http://localhost:3000/api${path}`, {
      headers: { Cookie: `__session=${token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    const text = await res.text();
    console.log(`\nGET ${path} -> ${res.status}`);
    console.log(text.slice(0, 1400));
    return res.status;
  };

  try {
    const queue = await call('/admin/support?limit=50');
    if (queue === 200) {
      const res = await fetch('http://localhost:3000/api/admin/support?limit=50', {
        headers: { Cookie: `__session=${token}` },
      });
      const json = (await res.json()) as { threads?: Array<{ ref: string; status: string }> };
      const first = json.threads?.[0];
      if (first) await call(`/admin/support/${first.ref}`);
    }
  } finally {
    await revokeSession(sessionId);
    console.log('\n(session revoked)');
  }
}

main().finally(() => process.exit(0));
