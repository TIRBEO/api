/**
 * The recovery email as it is shown to somebody who is not signed in.
 *
 * The security hub writes a recovery address as a row in `"email"."user_email"`
 * with `kind = 'recovery'`; it only counts once `verified_at` is set, because a
 * typed address is a contact, not a proven mailbox. Password reset may be
 * delivered to it — but only when it is proven, and only ever masked: this is
 * read by an unauthenticated endpoint that takes any address as input.
 *
 * `maskEmail` is the one masking the app already uses (the recovery-login
 * handler printed `ab****@gmail.com`), so the forgot-password screen and the
 * sign-in screen describe the same address the same way.
 */

/** `joe.bloggs@example.com` → `jo********@example.com` — the app's house style. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const keep = Math.min(local.length, 2);
  return `${local.slice(0, keep)}${'*'.repeat(Math.max(local.length - keep, 1))}@${domain}`;
}

/**
 * What the forgot-password screen is allowed to offer.
 *
 * `hasRecoveryEmail` is the only switch the client reads, and it is true only
 * for a verified recovery address that is not the login address itself — so a
 * dead "send it to my recovery email" button can never be rendered, and an
 * attacker typing a stranger's address learns nothing but a mask.
 */
export function recoveryOption(
  rows: { address: string; kind: string; verifiedAt: Date | null }[],
  primaryEmail: string | null,
): { hasRecoveryEmail: boolean; recoveryEmail: string | null } {
  const recovery = rows.find(
    (r) =>
      (r.kind === 'recovery' || r.kind === 'secondary') &&
      !!r.verifiedAt &&
      r.address.toLowerCase() !== (primaryEmail ?? '').toLowerCase(),
  );
  if (!recovery) return { hasRecoveryEmail: false, recoveryEmail: null };
  return { hasRecoveryEmail: true, recoveryEmail: maskEmail(recovery.address) };
}

/**
 * The recovery address a reset may be delivered to, or null.
 *
 * Delivery is refused for an address nobody proved they receive — otherwise a
 * person who once typed a typo into the security hub would have their password
 * reset code posted to somebody else's inbox, and whoever reads that inbox
 * takes the account.
 */
export async function verifiedRecoveryAddress(userId: string): Promise<string | null> {
  const { prisma } = await import('@/infrastructure/db/prisma');
  const row = await prisma.userEmail.findFirst({
    where: { userId, kind: { in: ['recovery', 'secondary'] }, verifiedAt: { not: null } },
    select: { address: true },
    orderBy: { createdAt: 'desc' },
  });
  return row?.address ?? null;
}
