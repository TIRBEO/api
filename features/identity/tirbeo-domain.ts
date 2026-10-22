/* The domain half of a Tirbeo identity, with nothing behind it but an env read.
 *
 * This file is deliberately import-free. `features/identity/tirbeo.ts` is the
 * same subject matter, but it reaches the database, and a build script that
 * only wants to know what a handle ends with must not boot a connection pool
 * to learn it. */

export const TIRBEO_MAIL_DOMAIN = (process.env.TIRBEO_MAIL_DOMAIN || 'tirbeo.com')
  .trim().toLowerCase().replace(/^@+/, '');
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
