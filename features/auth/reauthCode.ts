import { prisma } from '@/infrastructure/db/prisma';
import {
  issueSensitiveCode,
  consumeSensitiveCode,
} from '@/features/status/accountLifecycle';

/**
 * The emailed re-authentication code — the fourth proof for sensitive actions.
 *
 * The guard in `reauth.ts` accepted a passkey JWT, a password or a TOTP code.
 * An account created through OAuth with no password set and no passkey or
 * authenticator had no way to satisfy it, so it could not disable 2FA, revoke
 * its sessions, delete a passkey — or delete itself. This is that missing door:
 * a 6-digit code posted to the address the account signs in with.
 *
 * It is NOT new OTP machinery. Deletion and reactivation already shared one OTP
 * core (`issueSensitiveCode`/`consumeSensitiveCode` in the account-lifecycle
 * module) — same table, same hash, same 15-minute expiry, same resend cooldown,
 * same attempt counter that self-destructs the row. Each action only ever gets
 * its OWN kind so a code minted for one can't be spent on the other, so
 * `reauth` joins `account_delete` and `account_reactivate` as a third kind and
 * reuses everything else.
 */

/** Own kind: a code minted here can't delete an account, and vice versa. */
export const REAUTH_OTP_KIND = 'reauth';

/**
 * The account's primary sign-in address — the only place a code may go.
 *
 * Same lookup order as `primaryEmailOf` in `features/users/userHandlers.ts`:
 * the `kind='primary'` row of the email table first (the authoritative store),
 * then the legacy `users.email` column, so an account whose address lives in
 * only one of the two still gets its code. Never a recovery or secondary
 * address: this proves ownership of the account, and the sign-in address is
 * what ownership means here.
 */
export async function signInEmailOf(userId: string): Promise<string | null> {
  try {
    const row = await prisma.userEmail.findFirst({
      where: { userId, kind: 'primary' },
      select: { address: true },
    });
    if (row?.address) return row.address;
  } catch { /* fall through to the legacy column */ }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    return user?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Mint a reauth code for `userId` and mail it to `email`.
 *
 * Bound to the userId (the hash input is `${code}|${userId}`), so the code that
 * opens this account's sensitive action is useless on any other account even if
 * somebody read both inboxes. Resend-cooldown-limited exactly like the deletion
 * code: same 30s per-send gate, same 5-per-15-min window, keyed by kind+address.
 */
export function issueReauthCode(
  userId: string,
  email: string,
): ReturnType<typeof issueSensitiveCode> {
  return issueSensitiveCode(REAUTH_OTP_KIND, email, userId, userId);
}

/**
 * Verify a reauth code the caller presents.
 *
 * The caller only knows its own userId (from the session), never the address
 * the code was sent to — so the live row is found by userId+kind and then
 * handed to the shared core, which re-checks expiry, burns an attempt on a
 * miss, deletes the row on a hit, and self-destructs it past the threshold.
 */
export async function consumeReauthCode(userId: string, code: string): Promise<boolean> {
  let address: string | null = null;
  try {
    const otp = await prisma.otp.findFirst({
      where: { userId, kind: REAUTH_OTP_KIND },
      orderBy: { createdAt: 'desc' },
      select: { address: true },
    });
    address = otp?.address ?? null;
  } catch {
    return false;
  }
  // A code is only ever as good as the row it was minted against. No row (or a
  // row with no address — the core keys on address) means nothing to spend.
  if (!address) return false;

  return consumeSensitiveCode(REAUTH_OTP_KIND, address, code, userId);
}
