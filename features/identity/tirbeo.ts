import { prisma } from '@/infrastructure/db/prisma';
import type { UserStatusKind } from '@prisma/client';

// Tirbeo identities are company accounts on one well-known domain:
// username@tirbeo.com. The consolidated schema stores them directly:
//   - users.username          the public handle (unique)
//   - user_email (primary)    the login address (username@tirbeo.com or an
//                             external email for accounts without a handle)
//   - user_email (recovery)   contact/recovery address — NEVER a login identity

export const TIRBEO_MAIL_DOMAIN = 'tirbeo.com';
export const TIRBEO_MAIL_DOMAIN_LITE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-zA-Z0-9])?$/;

export function isValidTirbeoUsername(username?: string | null): username is string {
  return !!username && USERNAME_RE.test(username) && username.length <= 64;
}

export function tirbeoEmailFor(username: string): string {
  return `${username}@${TIRBEO_MAIL_DOMAIN}`;
}

export function isTirbeoEmail(email?: string | null): boolean {
  if (!email) return false;
  return email.split('@').pop()?.toLowerCase() === TIRBEO_MAIL_DOMAIN;
}

// Parse a login identifier. Accepts
//   - a bare username:   "alex"        (preferred UX, no domain typing)
//   - full tirbeo email: "alex@tirbeo.com"  (case-insensitive)
// Any other email domain is NOT a Tirbeo identity and returns null.
export function parseTirbeoIdentifier(identifier?: string | null): { username: string; email: string } | null {
  if (!identifier) return null;
  const value = identifier.trim().toLowerCase().replace(/\s+/g, '');
  if (!value) return null;
  if (value.includes('@')) {
    const [local, domain] = value.split('@');
    if (!local || domain !== TIRBEO_MAIL_DOMAIN) return null;
    if (!isValidTirbeoUsername(local)) return null;
    return { username: local, email: value };
  }
  if (!isValidTirbeoUsername(value)) return null;
  return { username: value, email: tirbeoEmailFor(value) };
}

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
//   - any EXTERNAL email               -> allowed only when the account has no
//     Tirbeo identity; otherwise the identity is authoritative and the external
//     address must NOT work as a login credential.
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
    return user ? { user, matchedBy: 'tirbeo_email' as const } : null;
  }

  // External domain: only a user WITHOUT a Tirbeo identity may sign in with it.
  const [local, domain] = raw.split('@');
  if (!local || !domain) return null;
  const user = await fetchLoginUserByEmail(raw);
  if (!user) return null;
  if (user.hasTirbeoIdentity) return null; // identity exists -> external email must not log in
  return { user, matchedBy: 'legacy_email' as const };
}

// Claim (or re-point) the canonical Tirbeo identity for a user:
// sets users.username and records username@tirbeo.com as the primary email.
export async function createTirbeoIdentity(input: {
  userId: string;
  username: string;
  source: 'sso' | 'admin' | 'self_service' | 'legacy';
}) {
  const username = input.username.trim().toLowerCase();
  if (!isValidTirbeoUsername(username)) {
    throw new Error('Invalid Tirbeo username. Use letters, numbers, dots, dashes or underscores.');
  }
  const email = tirbeoEmailFor(username);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: input.userId }, data: { username } });
    await tx.userEmail.upsert({
      where: { userId_address: { userId: input.userId, address: email } },
      create: { userId: input.userId, address: email, kind: 'primary', isDefault: true, verifiedAt: new Date() },
      update: { kind: 'primary', isDefault: true, verifiedAt: new Date() },
    });
  });
  return { userId: input.userId, username, email };
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
