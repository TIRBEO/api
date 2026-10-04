import { createSession, revokeSession } from '@/features/auth/session';

const userId = process.argv[2];

async function main() {
  if (!userId) throw new Error('usage: e2e-mint-session <userId> [sessionId-to-revoke]');
  const { token, sessionId } = await createSession(userId, 'Mozilla/5.0 (X11; Linux x86_64) Playwright E2E', '127.0.0.1');
  if (process.argv[3]) await revokeSession(process.argv[3]);
  console.log(JSON.stringify({ token, sessionId }));
}

main().finally(() => process.exit(0));
