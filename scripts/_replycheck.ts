import { prisma } from '@/infrastructure/db/prisma';
import { createSession, generateCsrfToken, revokeSession } from '@/features/auth/session';

/* Local end-to-end check of the panel's reply: answer a test thread through the
   running API, then read that thread and the account's own request record back.
   Only the responses are printed, and every minted session is revoked. */

const REF = process.env.CHECK_REF ?? 'e064-2835-95a8-e109';
const API = 'http://localhost:3000/api';

async function main() {
  const staff = await prisma.user.findFirst({ where: { isAdmin: true }, select: { id: true } });
  if (!staff) throw new Error('no admin account to mint for');

  const asked = await prisma.activityEvent.findFirst({
    where: { kind: 'support.request', metadata: { path: ['refCode'], equals: REF } },
    select: { userId: true, title: true, createdAt: true },
  });
  if (!asked?.userId) throw new Error(`no thread ${REF} with an account on it`);

  const account = await prisma.user.findUnique({
    where: { id: asked.userId },
    select: { email: true },
  });

  const admin = await createSession(staff.id, 'Mozilla/5.0 local reply check', '127.0.0.1');
  const csrf = generateCsrfToken();
  const owner = await createSession(asked.userId, 'Mozilla/5.0 local reply check', '127.0.0.1');

  const cookies = (token: string) => `__session=${token}; __csrf=${csrf}`;

  try {
    const said = 'Answered from the panel by the reply check. Nothing on your account was changed.';
    const res = await fetch(`${API}/admin/emails/reply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        Cookie: cookies(admin.token),
      },
      body: JSON.stringify({
        to: account?.email,
        subject: `Re: ${asked.title}`,
        html: `<p style="margin:0">${said}</p>`,
        refCode: REF,
        threadId: REF,
        receivedAt: asked.createdAt.toISOString(),
      }),
    });
    console.log('POST reply ->', res.status, (await res.text()).slice(0, 300));

    const thread = await fetch(`${API}/admin/support/${REF}`, {
      headers: { Cookie: cookies(admin.token) },
    }).then((r) => r.json());
    console.log('thread status:', thread.thread?.status, 'replies:', thread.thread?.messages?.length);
    console.log('staff message text:', JSON.stringify(thread.thread?.messages?.at(-1)?.text));

    const mine = await fetch(`${API}/user/requests`, { headers: { Cookie: cookies(owner.token) } })
      .then((r) => r.json());
    const row = mine.requests?.find((x: any) => x.ref === REF);
    console.log('account sees:', JSON.stringify(row, null, 1));

    const note = await prisma.notification.findMany({
      where: { userId: asked.userId, type: 'support' },
      orderBy: { createdAt: 'desc' },
      take: 1,
      select: { title: true, body: true, link: true, metadata: true },
    });
    console.log('notification:', JSON.stringify(note));
  } finally {
    await revokeSession(admin.sessionId);
    await revokeSession(owner.sessionId);
    console.log('(sessions revoked)');
  }
}

main().finally(() => process.exit(0));
