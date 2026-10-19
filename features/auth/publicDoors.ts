/* ═══════════════════════════════════════════════════════════════════
   The doors that need no session.

   Two places have to know this list — the edge (proxy) passes these through
   without authenticating, and the dispatcher must not let a closed account's
   stale cookie 403 a sign-in, or the person can never reach the screen that
   explains their own closure. Kept in one array so the two cannot drift.
   ═══════════════════════════════════════════════════════════════════ */

const PUBLIC_API_DOORS = [
  '/api/auth/login', '/api/auth/signup', '/api/auth/logout',
  '/api/auth/verify-email',
  '/api/auth/email-exists',
  '/api/auth/username-exists',
  '/api/auth/signup-otp/request', '/api/auth/signup-otp/verify',
  '/api/auth/login-otp/request', '/api/auth/login-otp/verify',
  '/api/auth/magic-link/request', '/api/auth/magic-link/verify',
  '/api/auth/verify-2fa', '/api/auth/recovery-2fa',
  '/api/auth/google', '/api/auth/google/callback', '/api/auth/github', '/api/auth/github/callback',
  '/api/auth/discord', '/api/auth/discord/callback',
  // login-merge: authorized by a signed short-lived token in the body, no session involved
  '/api/auth/oauth/merge',
  '/api/auth/oauth/pending', '/api/auth/oauth/complete', '/api/auth/oauth-consent', '/api/auth/oauth/consent',
  '/api/auth/password-reset/request', '/api/auth/password-reset/verify', '/api/auth/password-reset/confirm', '/api/auth/password-reset/quick-login',
  '/api/auth/email-otp/request', '/api/auth/email-otp/verify', '/api/auth/phone-otp/request', '/api/auth/phone-otp/verify',
  '/api/auth/account-recovery', '/api/auth/recovery-email/send-code',
  '/api/auth/refresh',
  '/api/auth/suspicious-login/confirm', '/api/auth/suspicious-login/deny',
  '/api/auth/verify',
  // The login screen shows attempt limits before any session exists, so these
  // reads are session-free by design. PUT/POST are protected — their handlers
  // enforce the admin role themselves.
  '/api/auth/limits', '/api/auth/remaining',
  '/api/admin/login', '/api/admin/verify-2fa', '/api/admin/change-password',
  '/api/admin/passkey/options', '/api/admin/passkey/verify',
  '/api/auth/passkey/auth-options', '/api/auth/passkey/verify',
  '/api/public/', '/api/newsletter/',
  '/api/waitlist',
  '/api/feedback',
  '/api/forms/public/',
  '/auth/google', '/auth/google/callback', '/auth/github', '/auth/github/callback',
  '/auth/discord', '/auth/discord/callback',
  '/api/image/',
  '/api/cdn/share/',
  '/api/cdn/u/',
  '/api/health',
  '/api/security/log',
  // Client telemetry lands events for logged-out visitors too; the ingest route
  // attributes a session when one is attached and rate-limits by IP.
  '/api/telemetry/',
  '/api/debug/',
  '/api/email/unsubscribe',
  '/api/emails/unsubscribe',
];

/** POST /api/forms/{slug}/submit authenticates with an access_key in the body. */
function isPublicFormSubmit(pathname: string, method: string): boolean {
  return method === 'POST' && /^\/api\/forms\/[^/]+\/submit\/?$/.test(pathname);
}

/** Takes `/api/${pathStr}` as well as a bare pathname, so the dispatcher and
 *  the edge ask the same question about the same request. */
export function isPublicApiDoor(pathname: string, method = 'GET'): boolean {
  const path = pathname.startsWith('/api/') || pathname.startsWith('/auth/') ? pathname : `/api/${pathname}`;
  return PUBLIC_API_DOORS.some((door) => path.startsWith(door)) || isPublicFormSubmit(path, method);
}
