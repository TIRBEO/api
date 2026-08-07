import { prisma } from './lib/db/prisma';
import { createSession } from './lib/auth/session';

async function main() {
  const email = process.env.MINT_EMAIL || 'bishnuneup4ne@gmail.com';
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No user for ${email}`);
  const session = await createSession(user.id);
  console.log(JSON.stringify({ token: session.token, refreshToken: session.refreshToken, userId: user.id }));
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
