import { prisma } from '@/infrastructure/db/prisma';
import { createSession, revokeSession } from '@/features/auth/session';

/* Read-only: what the account's own request record says about a thread. */
const REF = process.env.CHECK_REF ?? 'e064-2835-95a8-e109';

async function main() {
  const asked = await prisma.activityEvent.findFirst({
    where: { kind: 'support.request', metadata: { path: ['refCode'], equals: REF } },
    select: { userId: true },
  });
  if (!asked?.userId) throw new Error(`no thread ${REF}`);
  const { token, sessionId } = await createSession(asked.userId, 'Mozilla/5.0 local read', '127.0.0.1');
  try {
    const json = await fetch('http://localhost:3000/api/user/requests?limit=50', {
      headers: { Cookie: `__session=${token}` },
    }).then((r) => r.json());
    const rows = (json.requests ?? []).filter(
      (x: any) => x.kind?.startsWith('support.') || x.ref === REF,
    );
    console.log(JSON.stringify(rows, null, 1));
  } finally {
    await revokeSession(sessionId);
  }
}
main().finally(() => process.exit(0));
