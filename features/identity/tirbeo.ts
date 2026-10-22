import { prisma } from '@/infrastructure/db/prisma';
import type { UserStatusKind } from '@prisma/client';
import { TIRBEO_MAIL_DOMAIN, isValidTirbeoUsername, parseTirbeoIdentifier, tirbeoEmailFor } from './tirbeo-domain';

// The domain, the handle pattern and the pure parsers live in
// `tirbeo-domain.ts`, which imports nothing: this file is the database-facing
// half of the same subject, and the build-time mail check must not have to
// boot a connection pool to ask what a handle ends with.
export * from './tirbeo-domain';

// The login/auth view of a user, assembled from the consolidated tables.
// Field names mirror the pre-consolidation User columns so auth handlers
// keep reading naturally (user.email, user.is2FAEnabled, ...).
export interface LoginUser {
  id: string;
  email: string | null;
  username: string | null;
  passwordHash: string;
  is2FAEnabled: boolean;
  totpSecret: string | null;
  backupCodes: string[];
  mustChangePassword: boolean;
  status: UserStatusKind;
  isAdmin: boolean;
  name: string | null;
  photoUrl: string | null;
  recoveryEmail: string | null;
  hasTirbeoIdentity: boolean;
}

const loginInclude = {
  profile: { select: { name: true, photoUrl: true } },
  emails: { select: { address: true, kind: true } },
  security: { select: { totpEnabled: true, totpSecret: true, backupCodes: true, mustChangePw: true } },
} as const;

type LoginUserRow = {
  id: string;
  username: string | null;
  passwordHash: string;
  status: UserStatusKind;
  isAdmin: boolean;
  profile: { name: string | null; photoUrl: string | null } | null;
  emails: { address: string; kind: string }[];
  security: { totpEnabled: boolean; totpSecret: string | null; backupCodes: unknown; mustChangePw: boolean } | null;
};

export function toLoginUser(row: LoginUserRow): LoginUser {
  const identityEmail = row.username ? tirbeoEmailFor(row.username) : null;
  const primary =
    (identityEmail && row.emails.find((e) => e.address === identityEmail)) ||
    row.emails.find((e) => e.kind === 'primary' || e.kind === 'default') ||
    row.emails.find((e) => !e.address.endsWith(`@${TIRBEO_MAIL_DOMAIN}`)) ||
    row.emails[0];
  const recovery = row.emails.find((e) => e.kind === 'recovery' || e.kind === 'secondary');
  let backupCodes: string[] = [];
  try {
    const raw = row.security?.backupCodes;
    if (Array.isArray(raw)) backupCodes = raw as string[];
    else if (typeof raw === 'string') backupCodes = JSON.parse(raw);
  } catch { backupCodes = []; }
  return {
    id: row.id,
    email: primary?.address ?? null,
    username: row.username,
    passwordHash: row.passwordHash,
    is2FAEnabled: !!row.security?.totpEnabled,
    totpSecret: row.security?.totpSecret ?? null,
    backupCodes,
    mustChangePassword: !!row.security?.mustChangePw,
    status: row.status,
    isAdmin: row.isAdmin,
    name: row.profile?.name ?? null,
    photoUrl: row.profile?.photoUrl ?? null,
    recoveryEmail: recovery?.address ?? null,
    hasTirbeoIdentity: !!row.username,
  };
}

export async function fetchLoginUserById(userId: string): Promise<LoginUser | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, passwordHash: true, status: true, isAdmin: true, ...loginInclude },
  });
  return row ? toLoginUser(row as LoginUserRow) : null;
}

export async function fetchLoginUserByEmail(address: string): Promise<LoginUser | null> {
  const emailRow = await prisma.userEmail.findFirst({
    where: { address: address.toLowerCase().trim() },
    select: { user: { select: { id: true, username: true, passwordHash: true, status: true, isAdmin: true, ...loginInclude } } },
  });
  return emailRow?.user ? toLoginUser(emailRow.user as LoginUserRow) : null;
}

export async function fetchLoginUserByUsername(username: string): Promise<LoginUser | null> {
  const row = await prisma.user.findUnique({
    where: { username: username.toLowerCase().trim() },
    select: { id: true, username: true, passwordHash: true, status: true, isAdmin: true, ...loginInclude },
  });
  return row ? toLoginUser(row as LoginUserRow) : null;
}

// Resolve a login identifier to a user. Rules:
//   - username or username@tirbeo.com  -> the Tirbeo identity user
//   - any EXTERNAL email               -> the account that owns that address.
//     A Tirbeo username is a handle, not a wall: people keep typing the email
//     they signed up with, and it must keep working.
export async function resolveTirbeoIdentifier(
  identifier?: string | null,
) {
  if (!identifier) return null;
  const raw = identifier.trim().toLowerCase();
  if (!raw) return null;

  if (!raw.includes('@')) {
    if (!isValidTirbeoUsername(raw)) return null;
    const user = await fetchLoginUserByUsername(raw);
    return user ? { user, matchedBy: 'username' as const } : null;
  }

  const parsed = parseTirbeoIdentifier(raw);
  if (parsed) {
    const user = await fetchLoginUserByUsername(parsed.username);
    if (user) return { user, matchedBy: 'tirbeo_email' as const };
    // An @tirbeo.com address whose local part is not a username (legacy rows
    // carry the real email) still resolves through the email table below.
  }

  const user = await fetchLoginUserByEmail(raw);
  if (!user) return null;
  return { user, matchedBy: 'legacy_email' as const };
}

/** The address the account would be recovered with, and whether its owner has
    proved they receive it. Read from the same row setRecoveryContact writes, so
    a screen can't show an address the recovery mail would never go to — the
    legacy users.secondary_email column is not that row, and nothing that
    verifies a code touches it any more. */
export async function readRecoveryContact(userId: string): Promise<{ email: string; verified: boolean } | null> {
  const row = await prisma.userEmail.findFirst({
    where: { userId, kind: { in: ['recovery', 'secondary'] } },
    select: { address: true, verifiedAt: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  return { email: row.address, verified: !!row.verifiedAt };
}

// Store the recovery/contact address (never a login identity).
export async function setRecoveryContact(input: {
  userId: string;
  email: string;
  verifiedBy?: 'code' | 'upstream' | 'admin' | 'legacy' | null;
  verifiedAt?: Date | null;
}) {
  const email = input.email.trim().toLowerCase();
  const verifiedAt = input.verifiedAt === null ? null : (input.verifiedAt ?? new Date());
  // Never flip the login row. Rows are unique per (userId, address), so
  // setting the recovery contact to the account's own primary address would
  // rewrite that primary row to kind 'recovery' and strip the account's login
  // email. Guarded call sites reject this with a 400; the unguarded ones stop
  // here.
  const primary = await prisma.userEmail.findFirst({
    where: { userId: input.userId, kind: 'primary' },
    select: { address: true },
  });
  if (primary?.address?.toLowerCase() === email) return null;
  // Demote any previous recovery address for this user.
  const previous = await prisma.userEmail.findMany({ where: { userId: input.userId, kind: 'recovery' } });
  for (const row of previous) {
    await prisma.userEmail.delete({ where: { id: row.id } }).catch(() => {});
  }
  return prisma.userEmail.upsert({
    where: { userId_address: { userId: input.userId, address: email } },
    create: { userId: input.userId, address: email, kind: 'recovery', verifiedAt },
    update: { kind: 'recovery', verifiedAt },
  });
}

// The mail-account registry and provisioning log lived in tables that the
// consolidated DB no longer defines; mailbox anchoring is derived from the
// identity itself (users.username), so these are best-effort no-ops now.
export async function upsertMailAccount(_input: {
  userId: string;
  username: string;
  role?: 'admin' | 'user';
  disabled?: boolean;
  provisioned?: boolean;
  provisionedBy?: 'admin' | 'sso' | 'self_service';
}) {
  return null;
}

export async function recordProvisioning(_input: {
  userId: string;
  target: 'supabase_user' | 'tirbeo_identity' | 'mail_account';
  status: 'pending' | 'ok' | 'failed';
  method?: 'admin' | 'self_service' | 'sso' | 'legacy';
  detail?: string;
}) {
  return null;
}
