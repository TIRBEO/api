import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { verifyPassword } from '@/features/auth/password';
import { checkWindowLimitDB } from '@/features/captcha/risk';

/* ═══════════════════════════════════════════════════════════════════
   Blocked-account credential gate.

   The interruption screen (`apps/myprofile/app/blocked`) is reached signed
   out — a closed account has no session to spend — so before it shows any
   detail about the decision, the visitor has to prove they own the account
   with its real credentials. This endpoint is that check: sessionless,
   email + password, and it answers with the few display facts the screen
   needs (name, photo, handle) and nothing else.

   It is deliberately NOT a general password oracle: it only answers for an
   account that is actually in a closed state, so it can't be used to probe
   whether an arbitrary address has a given password. Failures are rate
   limited per IP and per email, same posture as the appeal endpoint that
   already authenticates closed accounts by credential.
   ═══════════════════════════════════════════════════════════════════ */

/** The statuses this screen exists for — a live account has no business here. */
const CLOSED = new Set(['deletion_pending', 'deactivated', 'banned', 'suspended', 'deleted']);

export async function blockedVerifyHandler(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      return NextResponse.json({ error: 'Enter the email and password for the account.' }, { status: 400 });
    }

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    // Two limiters: a wrong guess per IP, and a brute-force sweep per email.
    if (!(await checkWindowLimitDB(`blocked-verify:ip:${ip}`, 10, 15 * 60 * 1000, ip))) {
      return NextResponse.json({ error: 'Too many attempts. Try again in a few minutes.' }, { status: 429 });
    }
    if (!(await checkWindowLimitDB(`blocked-verify:email:${email}`, 5, 15 * 60 * 1000, ip))) {
      return NextResponse.json({ error: 'Too many attempts. Try again in a few minutes.' }, { status: 429 });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true, username: true, passwordHash: true, status: true,
        profile: { select: { name: true, photoUrl: true } },
      },
    });

    // Same message whether the account is missing, live, or the password is
    // wrong — the endpoint must not reveal which of the three it was.
    const refuse = () =>
      NextResponse.json({ error: 'Those details do not open this account.' }, { status: 401 });

    if (!user || !user.passwordHash || !CLOSED.has(user.status)) return refuse();

    const ok = await verifyPassword(user.passwordHash, password).catch(() => false);
    if (!ok) return refuse();

    return NextResponse.json({
      ok: true,
      name: user.profile?.name ?? null,
      photoUrl: user.profile?.photoUrl ?? null,
      username: user.username,
      status: user.status,
    });
  } catch (err: any) {
    console.error('[BLOCKED VERIFY]', err?.message || err);
    return NextResponse.json({ error: 'Could not verify those details.' }, { status: 500 });
  }
}
