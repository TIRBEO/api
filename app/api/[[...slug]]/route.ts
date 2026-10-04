import { NextResponse, NextRequest } from 'next/server';
import { prisma, isDbHealthy, dbErrorResponse } from '@/infrastructure/db/prisma';
import { getSession, requireSession } from '@/features/auth/http-guards';
import { logRequest } from '@/infrastructure/observability/logger';
import { withRequestOrigin } from '@/infrastructure/observability/requestContext';
import { jsonError, jsonForbidden } from '@/shared/response';
import { checkRateLimitWithInfo, ROUTE_LIMITS, type RateLimitResult } from '@/features/auth/rate-limit';
import { generateEventId } from '@/features/users/refcode';
import { isIpBlocked } from '@/features/security/security';

import {
  loginHandler,
  signupHandler,
  emailExistsHandler,
  usernameExistsHandler,
  verifySignupEmailHandler,
  logoutHandler,
  profileHandler,
  requestEmailOtpHandler,
  verifyEmailOtpHandler,
  changeEmailRequestHandler,
  changeEmailVerifyHandler,
  googleAuthRedirectHandler,
  googleAuthCallbackHandler,
  githubAuthRedirectHandler,
  githubAuthCallbackHandler,
  discordAuthRedirectHandler,
  discordAuthCallbackHandler,
  verify2faLoginHandler,
  recovery2faLoginHandler,
  recoveryLoginRequestHandler,
  recoveryLoginVerifyHandler,
  requestSignupOtpHandler,
  signupOtpVerifyHandler,
  oauthConsentHandler,
  oauthPendingHandler,
  oauthSignupCompleteHandler,

  requestLoginOtpHandler,
  verifyLoginOtpHandler,
  requestMagicLinkHandler,
  requestPasswordResetHandler,
  verifyPasswordResetHandler,
  confirmPasswordResetHandler,
  quickLoginWithOtpHandler,
  accountRecoveryHandler,
  suspiciousLoginConfirmHandler,
  suspiciousLoginDenyHandler,
  verifyHandler,

   cliTokenHandler,
   sessionHandler,
   refreshHandler,
   tokenHandler,
   sessionRevokeByTokenHandler } from '@/features/auth/authHandlers';

// oauthHandlers removed — OAuth2 server models deleted

import {
  extendedProfileHandler,
  changePasswordHandler,
  sessionsHandler,
  notificationsHandler,
  oauthUnlinkHandler,
  integrationsHandler,
  mergeAccountsHandler,
  userActivityHandler,
  userAppsHandler,
  userOverviewHandler,
  preferencesHandler,
  settingsHandler,
  consentHistoryHandler,
  setPasswordHandler,
  requestProfileEditOtpHandler,
  verifyProfileEditOtpHandler,
  avatarUploadHandler,
  notificationChannelsHandler,
  notificationCategoriesHandler,
  notificationSummaryHandler,
  notificationTipsHandler,
  exportDataHandler,
  deleteAccountRequestHandler,
  publicProfileHandler } from '@/features/users/userHandlers';

import { internalProfileHandler } from '@/features/users/internalProfileHandlers';

import { accountStatusHandler, adminAccountStatusHandler } from '@/features/status/accountStatus';
import { dataUsageHandler } from '@/features/preferences/dataUsage';

import {
  emailConfigHandler,
  emailTemplatesHandler,
  emailTemplateDetailHandler,
  emailTestHandler,
  adminEmailsHandler,
  adminEmailReplyHandler,
  adminEmailDetailHandler } from '@/features/email/emailAdminHandlers';


// helpHandlers removed — HelpArticle model deleted

// organizationHandlers removed (Organization feature not yet implemented)

import {
  securityEventsHandler,
  totpSetupHandler,
  totpVerifyHandler,
  totpDisableHandler,
  backupCodesRegenerateHandler,
  backupCodesListHandler,
  phonesAddHandler,
  phonesRemoveHandler,
  recoveryEmailHandler,
  recoveryEmailSendCodeHandler,
  recoveryEmailVerifyHandler,
  passwordCheckHandler,
  securityStatusHandler,
  sessionsRevokeAllHandler,
  sessionRevokeHandler } from '@/features/security/securityHandlers';

import {
  apiKeysHandler,
  apiKeyDeleteHandler } from '@/features/admin/developerHandlers';

import {
  chatHandler } from '@/features/auth/authHandlers';

// oauthAdminHandlers removed — OAuth2 server models deleted

import {
  knownAccountsHandler,
  switchAccountHandler,
  removeKnownAccountHandler } from '@/features/auth/accountSwitchHandlers';

// connectedAccountsHandler removed (LinkedAccount model removed)

import { adminAnalyticsOverviewHandler } from '@/features/admin/adminAnalytics';
import { adminAnalyticsConsentedUsersHandler } from '@/features/admin/adminAnalyticsHandlers';

import {
  loginHistoryHandler } from '@/features/security/securityHandlers';



import {
  publicHealthHandler, detailedHealthHandler, poolHealthHandler } from '@/features/observability/health';
import {
  cacheDebugHandler, cacheResetDebugHandler,
  queryPerfDebugHandler, queryPerfResetDebugHandler,
  queryPerfConfigDebugHandler, queryPerfConfigUpdateDebugHandler } from '@/features/admin/debugHandlers';

// jobs module removed

import { getAccountsBaseUrl, getDashboardBaseUrl, getFormsBaseUrl, getSupportBaseUrl, getAdminBaseUrl, getCdnBaseUrl, getMyprofileBaseUrl,  } from '@/config/app-urls';
import { accountChecksHandler } from '@/features/status/accountChecks';
import { appealFileHandler, appealsListHandler } from '@/features/support/appeals';

const appUrl = (subdomain: string, path: string) => {
  const base = (() => {
    switch (subdomain) {
      case 'dashboard': return getDashboardBaseUrl();
      case 'admin': return getAdminBaseUrl();
      case 'forms': return getFormsBaseUrl();
      case 'support': return getSupportBaseUrl();
      case 'cdn': return getCdnBaseUrl();
      case 'accounts': return getAccountsBaseUrl();
      default: return getAccountsBaseUrl();
    }
  })();
  return `${base}${path}`;
};

/**
 * Origins this server may proxy to even though they resolve to a private
 * address.
 *
 * The blanket private-address ban further down is the right default — it is what
 * stops a server that proxies on request from being turned into a reader for the
 * cloud metadata endpoint. But it bans the platform's own apps too, which in
 * development are `localhost:3005` and on a LAN are `192.168.*`: precisely the
 * addresses a service-to-service profile call has to make.
 *
 * So the exception is a fixed list built from server configuration and never
 * from anything in the request, matched on the full origin (scheme + host +
 * port) rather than a hostname suffix, so a lookalike host cannot inherit the
 * trust by ending with the same name.
 */
function trustedInternalOrigins(): Set<string> {
  const bases = [
    getMyprofileBaseUrl(), getAccountsBaseUrl(), getDashboardBaseUrl(),
    getAdminBaseUrl(), getFormsBaseUrl(), getCdnBaseUrl(), getSupportBaseUrl(),
  ];
  const origins = new Set<string>();
  for (const base of bases) {
    try {
      const parsed = new URL(base);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origins.add(parsed.origin);
    } catch {
      /* A malformed configured address narrows the list rather than widening
         it — the safe direction for a typo. */
    }
  }
  return origins;
}

const INTERNAL_ROUTES = [
  'auth/login', 'auth/signup', 'auth/email-exists', 'auth/username-exists', 'auth/logout',
  'auth/email-otp/request', 'auth/email-otp/verify',
    'auth/signup-otp/request', 'auth/signup-otp/verify',
    'auth/change-email/request', 'auth/change-email/verify',
  'auth/oauth-consent', 'auth/oauth/consent', 'auth/oauth/pending', 'auth/oauth/complete',
  'auth/login-otp/request', 'auth/login-otp/verify',
  'auth/magic-link/request', 'auth/magic-link/verify',
  'auth/google', 'auth/google/callback', 'auth/github', 'auth/github/callback',
  'auth/discord', 'auth/discord/callback',
  'auth/verify-2fa', 'auth/recovery-2fa',
  'auth/recovery-login/request', 'auth/recovery-login/verify',
  'auth/password-reset/request', 'auth/password-reset/verify', 'auth/password-reset/confirm', 'auth/password-reset/quick-login',
   'auth/account-recovery',
   'auth/suspicious-login/confirm', 'auth/suspicious-login/deny',
   'auth/session',
   'auth/refresh',
   'auth/token',
   'auth/accounts', 'auth/switch-account', 'auth/accounts/remove',
   'security/session-revoke',
   'auth/verify-email', 'auth/verify',
  'users/me',
  // 'internal/profile' is the profile service's own path to the account row. It
  // authenticates with a shared service token instead of a session, so the
  // per-request session lookup, role check and rate-limit bucket that a browser
  // call pays for are not paid again for the same profile four times over.
  'profile', 'internal/profile', 'security/password', 'security/sessions', 'security/set-password',
  'security/events', 'security/totp/setup', 'security/totp/verify', 'security/totp/disable',
  'security/backup-codes/list', 'security/backup-codes/regenerate', 'security/phones', 'security/recovery-email', 'security/recovery-email/send-code', 'security/recovery-email/verify',
  'security/password-check', 'security/sessions/revoke-all', 'security/login-history', 'security/status',
  'profile/request-edit-otp', 'profile/verify-edit-otp', 'profile/avatar', 'profile/check-username',
  'notifications', 'notifications/prefs', 'notifications/prefs/channels', 'notifications/prefs/categories', 'notifications/prefs/summary', 'notifications/prefs/tips', 'integrations', 'integrations/merge', 'user/activity', 'preferences', 'preferences/data-usage', 'settings', 'consent-history',
  'admin/heartbeat',
  'email/config', 'email/templates', 'email/test', 'email/unsubscribe',  'admin/emails', 'admin/emails/reply', 'admin/email-preview',
  'emails', 'emails/unsubscribe', 'emails/preferences', 'pushes',
  'districts',
  'developer/api-keys',
  'user/activity', 'user/apps', 'user/overview', 'user/account-status', 'user/account-checks',
  'admin/reserved-addresses',
  'admin/groups',
  'admin/account-status',
  'admin/ous', 'admin/security/score',
  'admin/settings', 'admin/analytics/overview', 'admin/analytics/consented-users', 'admin/maintenance',
  // connected-accounts removed — OAuth IDs stored on users table directly
  'user/export-data', 'user/delete-account', 'profile/public',
  'content/incident-events', 'content/health', 'content/jobs', 'content/jobs/create', 'content/retry-job',
  'support/tickets/[id]/read', 'support/tickets/[id]/attachments', 'support/tickets/[id]/attachments/[attachmentId]',
    'auth/cli-token',
   'waitlist',
   'feedback',
   'chat',
   'admin/subscribers',
   'admin/feedback',    'health',
    'health/pool',
    'debug/cache',
    'debug/cache/reset',
    'debug/query-perf',
    'debug/query-perf/reset',
    'debug/query-perf/config',
    'debug/rate-limits/reset',
  // Support
  'support/tickets', 'support/tickets/create',  'support/tickets/appeals', 'support/appeal',


];

// The blocklist table is gone. IP blocks are Redis-backed now (isIpBlocked in
// features/security/security.ts — same stale-tolerant contract, never throws),
// and user blocks are derived from the consolidated account status:
// suspended | deletion_pending | deleted are the blocking states.
const USER_BLOCK_CACHE_TTL = 60000; // 60s cache for blocks — stale-while-revalidate pattern
const USER_BLOCK_STALE_TTL = 300_000; // serve stale data for up to 5 min if DB is down
const BLOCKED_USER_STATUSES = new Set(['suspended', 'deletion_pending', 'deleted', 'restricted']);
const userBlockCache = new Map<string, { blocked: boolean; ts: number }>();

async function isUserBlocked(userId?: string) {
  if (!userId) return false;
  const hit = userBlockCache.get(userId);
  if (hit && Date.now() - hit.ts < USER_BLOCK_CACHE_TTL) return hit.blocked;    try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    const blocked = !!user && BLOCKED_USER_STATUSES.has(user?.status);
    userBlockCache.set(userId, { blocked, ts: Date.now() });
    if (userBlockCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of userBlockCache) { if (now - v.ts > USER_BLOCK_CACHE_TTL) userBlockCache.delete(k); }
    }
    return blocked;
  } catch (e: any) {
    console.error('[BLOCKLIST] user status query failed, serving stale cache:', e?.message);
    // Serve stale cache if available instead of failing
    if (hit && Date.now() - hit.ts < USER_BLOCK_STALE_TTL) return hit.blocked;
    return false;
  }
}

interface RouteMatch {
  path: string;
  method: string;
  internal: boolean;
  allowedRoles: string[];
  meta?: Record<string, string | undefined>;
  /** Optional absolute proxy target; derived from path when absent. */
  target?: string;
}

function matchRoute(slug: string[], method: string): RouteMatch | undefined {
  const pathPart = slug.join('/');

  // Handle email/templates/{name} dynamic route
  // Handle admin/emails/{id} dynamic route
  if (slug.length === 3 && slug[0] === 'admin' && slug[1] === 'emails') {
    const emailId = slug[2];
    if (method.toUpperCase() === 'GET') {
      return { path: 'admin/emails/[id]', method: 'GET', internal: true, allowedRoles: ['guest'], meta: { emailId } };
    }
  }

  // Handle security/sessions/{id} dynamic route
  if (slug.length === 3 && slug[0] === 'security' && slug[1] === 'sessions' && slug[2] !== 'revoke-all') {
    const sessionId = slug[2];
    if (method.toUpperCase() === 'DELETE') {
      return { path: 'security/sessions/[id]', method, internal: true, allowedRoles: ['guest'], meta: { sessionId } };
    }
  }

  // Handle developer/api-keys/{id} dynamic route
  if (slug.length === 3 && slug[0] === 'developer' && slug[1] === 'api-keys') {
    const keyId = slug[2];
    if (method.toUpperCase() === 'DELETE') {
      return { path: 'developer/api-keys/[id]', method, internal: true, allowedRoles: ['guest'], meta: { keyId } };
    }
  }

  // Handle admin/reserved-addresses/{id} dynamic route
  if (slug.length === 3 && slug[0] === 'admin' && slug[1] === 'reserved-addresses') {
    const addressId = slug[2];
    if (method.toUpperCase() === 'DELETE') {
      return { path: 'admin/reserved-addresses/[id]', method, internal: true, allowedRoles: ['guest'], meta: { addressId } };
    }
  }

// connected-accounts routes removed (LinkedAccount model removed)

  // Handle content/retry-job/{id} dynamic route
  if (slug.length === 3 && slug[0] === 'content' && slug[1] === 'retry-job') {
    return { path: 'content/retry-job/[id]', method: 'POST', internal: true, allowedRoles: ['guest'], meta: { retryJobId: slug[2] } };
  }

  // Handle support/tickets/{id} dynamic route (GET/PATCH/PUT/DELETE)
  // 'appeals' is a collection name, not a ticket id — it resolves through the
  // static methodMap below to the appeals list handler.
  if (slug.length === 3 && slug[0] === 'support' && slug[1] === 'tickets' && slug[2] !== 'appeals') {
    const ticketId = slug[2];
    const allowed = ['GET', 'PATCH', 'PUT', 'DELETE'];
    if (allowed.includes(method.toUpperCase())) {
      return { path: 'support/tickets/[id]', method, internal: true, allowedRoles: ['guest'], meta: { ticketId } };
    }
  }

  // Handle support/tickets/{id}/attachments/{attachmentId} — signed download (auth + Content-Disposition)
  if (slug.length === 5 && slug[0] === 'support' && slug[1] === 'tickets' && slug[3] === 'attachments') {
    return { path: 'support/tickets/[id]/attachments/[attachmentId]', method, internal: true, allowedRoles: ['guest'], meta: { ticketId: slug[2], attachmentId: slug[4] } };
  }

  // Handle support/tickets/{id}/messages, reply, read, assign, close, reopen, attachments
  if (slug.length === 4 && slug[0] === 'support' && slug[1] === 'tickets') {
    const action = slug[3];
    if (['messages', 'reply', 'read', 'assign', 'close', 'reopen', 'attachments'].includes(action)) {
      return { path: `support/tickets/[id]/${action}`, method, internal: true, allowedRoles: ['guest'], meta: { ticketId: slug[2] } };
    }
  }

  // Handle profile/oauth/{provider} dynamic route (unlink OAuth account)
  if (slug.length === 3 && slug[0] === 'profile' && slug[1] === 'oauth') {
    if (method.toUpperCase() === 'DELETE') {
      return { path: 'profile/oauth/[provider]', method, internal: true, allowedRoles: ['guest'], meta: { provider: slug[2] } };
    }
  }

  if (INTERNAL_ROUTES.includes(pathPart)) {
    const methodMap: Record<string, string[]> = {
      'auth/login': ['POST'],
      'auth/signup': ['POST'],
      'auth/email-exists': ['POST'],
      'auth/username-exists': ['POST'],
      'profile/check-username': ['GET'],
      'auth/verify-email': ['POST'],
      'auth/verify': ['GET'],
      'auth/logout': ['POST'],
      'auth/email-otp/request': ['POST'],
      'auth/email-otp/verify': ['POST'],
       'auth/signup-otp/request': ['POST'],
       'auth/signup-otp/verify': ['POST'],
       'auth/change-email/request': ['POST'],
       'auth/change-email/verify': ['POST'],
      'auth/oauth-consent': ['POST'],
      'auth/oauth/consent': ['POST'],
      'auth/oauth/pending': ['GET'],
      'auth/oauth/complete': ['POST'],
      'auth/login-otp/request': ['POST'],
      'auth/login-otp/verify': ['POST'],
      'auth/magic-link/request': ['POST'],
      'auth/magic-link/verify': ['GET', 'POST'],
      'auth/google': ['GET'],
      'auth/google/callback': ['GET'],
      'auth/github': ['GET'],
      'auth/github/callback': ['GET'],
      'auth/discord': ['GET'],
      'auth/discord/callback': ['GET'],
      'auth/verify-2fa': ['POST'],
      'auth/recovery-2fa': ['POST'],
      'auth/recovery-login/request': ['POST'],
      'auth/recovery-login/verify': ['POST'],
      'auth/password-reset/request': ['POST'],
      'auth/password-reset/verify': ['POST'],
      'auth/password-reset/confirm': ['POST'],
      'auth/password-reset/quick-login': ['POST'],
       'auth/account-recovery': ['POST'],
       'auth/suspicious-login/confirm': ['POST'],
       'auth/suspicious-login/deny': ['POST'],
       'auth/session': ['GET'],
       'auth/refresh': ['POST'],
       'auth/token': ['GET'],
       'auth/accounts': ['GET'],
       'auth/switch-account': ['POST'],
       'auth/accounts/remove': ['POST'],
        'security/session-revoke': ['POST'],
       'users/me': ['GET', 'PATCH'],
      'profile': ['GET', 'PATCH', 'PUT'],
      'internal/profile': ['GET', 'PATCH'],
      'security/password': ['POST'],
      'security/sessions': ['GET', 'DELETE'],
      'security/set-password': ['POST'],
      'security/events': ['GET'],
      'security/totp/setup': ['POST'],
      'security/totp/verify': ['POST'],
      'security/totp/disable': ['DELETE'],
      'security/backup-codes/list': ['GET'],
      'security/backup-codes/regenerate': ['POST'],
      'security/phones': ['POST', 'DELETE'],
      'security/recovery-email': ['PUT'],
      'security/recovery-email/send-code': ['POST'],
      'security/recovery-email/verify': ['POST'],
      'security/login-history': ['GET'],
      'security/password-check': ['POST'],
      'security/status': ['GET'],
      'security/sessions/revoke-all': ['DELETE'],
      'profile/request-edit-otp': ['POST'],
      'profile/verify-edit-otp': ['POST'],
      'profile/avatar': ['POST'],
      'notifications': ['GET', 'PATCH', 'DELETE'],
      'notifications/prefs': ['GET', 'PUT'],
      'notifications/prefs/channels': ['GET', 'PUT'],
      'notifications/prefs/categories': ['GET', 'PUT'],
      'notifications/prefs/summary': ['GET', 'PUT'],
      'notifications/prefs/tips': ['GET', 'PUT'],
      'integrations': ['GET', 'POST', 'DELETE'],
      'integrations/merge': ['POST'],

      'user/activity': ['GET'],
      'preferences': ['GET', 'PATCH'],
      'preferences/data-usage': ['GET', 'PUT', 'PATCH'],
      'settings': ['GET', 'PATCH'],
      'consent-history': ['GET'],
      'admin/heartbeat': ['POST'],
      'email/config': ['GET', 'PATCH'],
      'email/templates': ['GET', 'POST'],
      'email/test': ['POST'],
      'email/unsubscribe': ['GET', 'POST'],
      'admin/emails': ['GET'],
      'admin/emails/reply': ['POST'],
      'admin/email-preview': ['GET'],
      'emails': ['GET'],
      'emails/preferences': ['GET', 'POST'],
      'emails/unsubscribe': ['GET', 'POST'],
      'pushes': ['GET'],
      'districts': ['GET'],
      'developer/api-keys': ['GET', 'POST'],
      'user/apps': ['GET', 'POST', 'PUT', 'DELETE'],
      'user/overview': ['GET'],
      'user/account-status': ['GET'],
      'user/account-checks': ['GET'],
      'admin/account-status': ['PUT'],
      'admin/reserved-addresses': ['GET', 'POST'],
      'admin/groups': ['GET', 'POST'],
      'admin/ous': ['GET', 'POST'],
      'admin/security/score': ['GET'],
      'admin/settings': ['GET', 'PATCH'],
      'admin/maintenance': ['GET', 'POST'],
      'admin/analytics/overview': ['GET'],
      'admin/analytics/consented-users': ['GET'],
      // connected-accounts removed — OAuth IDs stored on users table directly
      'user/export-data': ['GET', 'POST'],
      'user/delete-account': ['GET', 'POST', 'DELETE'],
      'profile/public': ['GET'],       'auth/cli-token': ['POST'],
       'waitlist': ['POST'],
      'feedback': ['POST', 'GET'],
      'chat': ['POST'],
      'admin/subscribers': ['GET'],
      'admin/feedback': ['GET'],
      'health': ['GET'],
      'health/pool': ['GET'],
      'debug/cache': ['GET'],
      'debug/cache/reset': ['POST'],
      'debug/query-perf': ['GET'],
      'debug/query-perf/reset': ['POST'],
      'debug/query-perf/config': ['GET', 'PUT'],
      'debug/rate-limits/reset': ['POST'],
      // Content

      'content/health': ['GET'],
      'content/incident-events': ['GET', 'POST'],
      'content/jobs': ['GET'],
      'content/jobs/create': ['POST'],
      'content/retry-job': ['POST'],
      // Support
      'support/tickets': ['GET', 'POST'],
      'support/tickets/create': ['POST'],
      'support/appeal': ['POST'],
      'support/tickets/[id]/read': ['POST'],
      'support/tickets/[id]/attachments': ['GET', 'POST'],
      'support/tickets/[id]/attachments/[attachmentId]': ['GET'],
      'support/tickets/appeals': ['GET'] };
    const allowed = methodMap[pathPart];
    if (allowed && allowed.includes(method.toUpperCase())) {
      return { path: pathPart, method, internal: true, allowedRoles: ['guest'] };
    }
  }
  return undefined;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  return handler(request, slug, 'GET');
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  return handler(request, slug, 'POST');
}
export async function PUT(request: NextRequest, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  return handler(request, slug, 'PUT');
}
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  return handler(request, slug, 'DELETE');
}
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  return handler(request, slug, 'PATCH');
}

/**
 * Every API route in one door, which is why the request's origin is put on the
 * async chain here: a change written three calls deep can say which machine and
 * which place it came from without fifty handlers threading `request` down to
 * the writer. See infrastructure/observability/requestContext.
 */
async function handler(request: NextRequest, slug: string[], method: string) {
  return withRequestOrigin(request.headers, () => dispatch(request, slug, method));
}

async function dispatch(request: NextRequest, slug: string[], method: string) {
  const rawIp = request.headers.get('x-forwarded-for') || '';
  const ip = rawIp.split(',')[0].trim();
  const authHeader = request.headers.get('authorization') || '';
  const pathStr = slug.join('/');
  let session: any = null;
  let authMethod: 'cookie' | 'api-key' | 'none' = 'none';


  try {
    session = await getSession(request);
    if (session) {
      if (session.sessionId?.startsWith('apikey:')) {
        authMethod = 'api-key';
        console.log(`[AUTH] API key auth success — user: ${session.userId}, path: ${pathStr}, method: ${method}`);
      } else {
        authMethod = 'cookie';
      }
    } else if (authHeader) {
      // Only actual API keys (tb_…) can resolve via the API-key path. A Bearer
      // JWT (eyJ…) is handled by cookie/session auth above — do NOT log it as an
      // API-key failure, or every dashboard request spams 401-noise even on 200s.
      const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (bearerToken.startsWith('tb_')) {
        console.warn(`[AUTH] API key auth FAILED — header present but no valid key found, path: ${pathStr}, method: ${method}`);
      }
    }
  } catch (e: any) {
    console.error('[HANDLER] getSession failed:', e?.message);
  }

  // ── Vercel serverless: trigger due background jobs on first request ──
  // Fire-and-forget — does not block the response.
  if (process.env.VERCEL && pathStr !== 'cron') {
    import('@/jobs/job-gate').then(({ runDueJobs }) => {
      runDueJobs().catch(() => {});
    }).catch(() => {});
  }

  let blocked = false;
  try {
    blocked = (await isIpBlocked(ip)) || (await isUserBlocked(session?.userId));
  } catch (e: any) {
    console.error('[HANDLER] block check failed:', e?.message);
    return NextResponse.json({ error: 'Database connection error' }, { status: 500 });
  }

  if (blocked) {
    console.warn(`[AUTH] Blocked request — ip: ${ip}, user: ${session?.userId}, path: ${pathStr}`);
    await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: 403 });
    return jsonForbidden('Your IP or account has been blocked');
  }

  // Redirect user-facing paths to the dashboard instead of returning 404.
  // The API server only serves /api/* routes; pages live on dashboard.tirbeo.com.
  // Skip paths that are registered internal API routes (e.g. support/tickets).
  if (!pathStr || pathStr.startsWith('account') || pathStr.startsWith('settings') || pathStr.startsWith('overview') || pathStr.startsWith('support')) {
    const isInternal = INTERNAL_ROUTES.some((r) => pathStr === r || pathStr.startsWith(r + '/'));
    if (!isInternal) {
      const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.com';
      const dashboardBase = `https://dashboard.${appDomain}`;
      if (!pathStr) {
        return NextResponse.json({
          service: 'Tirbeo API',
          status: 'healthy',
          docs: '/api/health',
          dashboard: dashboardBase,
          accounts: `https://accounts.${appDomain}` });
      }
      const target = `${dashboardBase}/${pathStr}`;
      return NextResponse.redirect(target);
    }
  }

  const route = matchRoute(slug, method);
  if (!route) {
    console.warn(`[ROUTE] Not found — path: ${pathStr}, method: ${method}`);
    await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: 404 });
    return jsonError(`Route not configured: ${method} ${pathStr}`, 404);
  }

  let rateLimitInfo: RateLimitResult | null = null;
  const routeLimit = ROUTE_LIMITS[pathStr] ?? (route.path ? ROUTE_LIMITS[route.path] : undefined);
  const isAuth = pathStr.startsWith('auth/');
  rateLimitInfo = await checkRateLimitWithInfo(`${pathStr}:${ip}`, isAuth, routeLimit);
  if (!rateLimitInfo.allowed) {
    console.warn(`[RATE LIMIT] Exceeded — path: ${pathStr}, ip: ${ip}`);
    await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: 429 });
    return NextResponse.json({ error: 'Too many requests. Please slow down.' }, { status: 429, headers: { 'Retry-After': String(rateLimitInfo.reset), 'X-RateLimit-Limit': String(rateLimitInfo.limit), 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(rateLimitInfo.reset) } });
  }

  // Helper to add rate limit headers to a response
  function addRateLimitHeaders(response: NextResponse): NextResponse {
    if (rateLimitInfo) {
      response.headers.set('X-RateLimit-Limit', String(rateLimitInfo.limit));
      response.headers.set('X-RateLimit-Remaining', String(rateLimitInfo.remaining));
      response.headers.set('X-RateLimit-Reset', String(rateLimitInfo.reset));
    }
    return response;
  }

  // ── DB Health Check ──
  // Quick cached check — if DB is confirmed down, return 503 immediately
  // without waiting for the query to timeout. Health and auth routes bypass
  // this check since they handle their own DB errors gracefully.
  const SKIP_DB_CHECK = [
    'health', 'health/pool',
    'public/app-config', 'public/help-config', 'public/faq', 'public/theme',
    'public/branding', 'public/landing', 'public/landing-config', 'admin/check-setup',
    'auth/google', 'auth/google/callback', 'auth/github', 'auth/github/callback',
    'auth/discord', 'auth/discord/callback', 'auth/refresh', 'auth/session',
  ];
  if (!SKIP_DB_CHECK.includes(pathStr)) {
    const dbOk = await isDbHealthy();
    if (!dbOk) {
      console.warn(`[DB-HEALTH] Rejecting request — DB is down: ${method} ${pathStr}`);
      return dbErrorResponse() as any;
    }
  }

  if (route.internal) {
    let resp: NextResponse;
    try {
      switch (route.path) {
      case 'auth/login':
        resp = await loginHandler(request);
        break;
      case 'auth/signup':
        resp = await signupHandler(request);
        break;
      case 'auth/email-exists':
        resp = await emailExistsHandler(request);
        break;
      case 'auth/username-exists':
        resp = await usernameExistsHandler(request);
        break;
      case 'auth/verify-email':
        resp = await verifySignupEmailHandler(request);
        break;
      case 'auth/logout':
        resp = await logoutHandler(request);
        break;
      case 'users/me':
        resp = await profileHandler(request);
        break;
      case 'auth/email-otp/request':
        resp = await requestEmailOtpHandler(request);
        break;
      case 'auth/email-otp/verify':
        resp = await verifyEmailOtpHandler(request);
        break;
      case 'auth/signup-otp/request':
        resp = await requestSignupOtpHandler(request);
        break;
      case 'auth/signup-otp/verify':
        resp = await signupOtpVerifyHandler(request);
        break;
      case 'auth/change-email/request':
        resp = await changeEmailRequestHandler(request);
        break;
      case 'auth/change-email/verify':
        resp = await changeEmailVerifyHandler(request);
        break;
      case 'auth/oauth-consent':
      case 'auth/oauth/consent':
        resp = await oauthConsentHandler(request);
        break;
      case 'auth/oauth/pending':
        resp = await oauthPendingHandler(request);
        break;
      case 'auth/oauth/complete':
        resp = await oauthSignupCompleteHandler(request);
        break;
      case 'auth/login-otp/request':
        resp = await requestLoginOtpHandler(request);
        break;
      case 'auth/login-otp/verify':
        resp = await verifyLoginOtpHandler(request);
        break;
      case 'auth/magic-link/request':
        resp = await requestMagicLinkHandler(request);
        break;
      case 'auth/google':
        resp = await googleAuthRedirectHandler(request);
        break;
      case 'auth/google/callback':
        resp = await googleAuthCallbackHandler(request);
        break;
      case 'auth/github':
        resp = await githubAuthRedirectHandler(request);
        break;
      case 'auth/github/callback':
        resp = await githubAuthCallbackHandler(request);
        break;
      case 'auth/discord':
        resp = await discordAuthRedirectHandler(request);
        break;
      case 'auth/discord/callback':
        resp = await discordAuthCallbackHandler(request);
        break;
      case 'auth/session':
        resp = await sessionHandler(request);
        break;
      case 'auth/refresh':
        resp = await refreshHandler(request);
        break;
      case 'auth/token':
        resp = await tokenHandler(request);
        break;
      case 'auth/accounts':
        resp = await knownAccountsHandler(request);
        break;
      case 'auth/switch-account':
        resp = await switchAccountHandler(request);
        break;
      case 'auth/accounts/remove':
        resp = await removeKnownAccountHandler(request);
        break;
      case 'security/session-revoke':
        resp = await sessionRevokeByTokenHandler(request);
        break;
      case 'auth/account-recovery':
        resp = await accountRecoveryHandler(request);
        break;
      case 'auth/suspicious-login/confirm':
        resp = await suspiciousLoginConfirmHandler(request);
        break;
      case 'auth/suspicious-login/deny':
        resp = await suspiciousLoginDenyHandler(request);
        break;
      case 'auth/verify-2fa':
        resp = await verify2faLoginHandler(request);
        break;
      case 'auth/recovery-2fa':
        resp = await recovery2faLoginHandler(request);
        break;
      case 'auth/recovery-login/request':
        resp = await recoveryLoginRequestHandler(request);
        break;
      case 'auth/recovery-login/verify':
        resp = await recoveryLoginVerifyHandler(request);
        break;
      case 'auth/password-reset/request':
        resp = await requestPasswordResetHandler(request);
        break;
      case 'auth/password-reset/verify':
        resp = await verifyPasswordResetHandler(request);
        break;
      case 'auth/password-reset/confirm':
        resp = await confirmPasswordResetHandler(request);
        break;
      case 'auth/password-reset/quick-login':
        resp = await quickLoginWithOtpHandler(request);
        break;
      case 'profile':
        resp = await extendedProfileHandler(request);
        break;
      case 'internal/profile':
        resp = await internalProfileHandler(request);
        break;
      case 'security/password':
        resp = await changePasswordHandler(request);
        break;
      case 'security/sessions':
        resp = await sessionsHandler(request);
        break;
      case 'security/set-password':
        resp = await setPasswordHandler(request);
        break;
      case 'security/events':
        resp = await securityEventsHandler(request);
        break;
      case 'security/login-history':
        resp = await loginHistoryHandler(request);
        break;
      case 'security/totp/setup':
        resp = await totpSetupHandler(request);
        break;
      case 'security/totp/verify':
        resp = await totpVerifyHandler(request);
        break;
      case 'security/totp/disable':
        resp = await totpDisableHandler(request);
        break;
      case 'security/backup-codes/list':
        resp = await backupCodesListHandler(request);
        break;
      case 'security/backup-codes/regenerate':
        resp = await backupCodesRegenerateHandler(request);
        break;
      case 'security/phones':
        resp = (method.toUpperCase() === 'POST') ? await phonesAddHandler(request) : await phonesRemoveHandler(request);
        break;
      case 'security/recovery-email':
        resp = await recoveryEmailHandler(request);
        break;
      case 'security/recovery-email/send-code':
        resp = await recoveryEmailSendCodeHandler(request);
        break;
      case 'security/recovery-email/verify':
        resp = await recoveryEmailVerifyHandler(request);
        break;
      case 'security/password-check':
        resp = await passwordCheckHandler(request);
        break;
      case 'security/status':
        resp = await securityStatusHandler(request);
        break;
      case 'security/sessions/revoke-all':
        resp = await sessionsRevokeAllHandler(request);
        break;
      case 'security/sessions/[id]':
        resp = await sessionRevokeHandler(request, (route as any).meta.sessionId);
        break;
      case 'profile/request-edit-otp':
        resp = await requestProfileEditOtpHandler(request);
        break;
      case 'profile/verify-edit-otp':
        resp = await verifyProfileEditOtpHandler(request);
        break;
      case 'profile/avatar':
        resp = await avatarUploadHandler(request);
        break;
      case 'profile/check-username':
        resp = await usernameExistsHandler(request);
        break;
      case 'profile/oauth/[provider]':
        resp = await oauthUnlinkHandler(request, (route as any).meta.provider);
        break;
      case 'notifications':
        resp = await notificationsHandler(request);
        break;
      // notifications/prefs handled by standalone route at app/api/notifications/prefs/
      case 'notifications/prefs/channels':
        resp = await notificationChannelsHandler(request);
        break;
      case 'notifications/prefs/categories':
        resp = await notificationCategoriesHandler(request);
        break;
      case 'notifications/prefs/summary':
        resp = await notificationSummaryHandler(request);
        break;
      case 'notifications/prefs/tips':
        resp = await notificationTipsHandler(request);
        break;
      // notifications/push routes handled by standalone routes at app/api/notifications/push/
      case 'integrations':
        resp = await integrationsHandler(request);
        break;
      case 'integrations/merge':
        resp = await mergeAccountsHandler(request);
        break;
      case 'user/activity':
        resp = await userActivityHandler(request);
        break;
      case 'preferences':
        resp = await preferencesHandler(request);
        break;
      case 'preferences/data-usage':
        resp = await dataUsageHandler(request);
        break;
      case 'user/account-status':
        resp = await accountStatusHandler(request);
        break;
      case 'user/account-checks':
        resp = await accountChecksHandler(request);
        break;
      case 'admin/account-status':
        resp = await adminAccountStatusHandler(request);
        break;
      case 'settings':
        resp = await settingsHandler(request);
        break;
      case 'consent-history':
        resp = await consentHistoryHandler(request);
        break;
      // admin/heartbeat handled by standalone route at app/api/admin/heartbeat/
      case 'email/config':
        resp = await emailConfigHandler(request);
        break;
      case 'email/templates':
        resp = await emailTemplatesHandler(request);
        break;
      case 'email/test':
        resp = await emailTestHandler(request);
        break;
      case 'email/unsubscribe': {
        const url = new URL(request.url);
        const token = url.searchParams.get('token') || '';
        if (!token) {
          resp = NextResponse.json({ error: 'Missing token' }, { status: 400 });
          break;
        }
        const { verifyUnsubscribeToken, processUnsubscribe } = await import('@/features/email/emailPrefs');
        const decoded = verifyUnsubscribeToken(token);
        if (!decoded) {
          resp = NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 });
          break;
        }
        await processUnsubscribe(decoded.userId, decoded.category);
        const apiBase = process.env.NEXT_PUBLIC_API_URL || 'https://api.tirbeo.com';
        resp = NextResponse.redirect(`${apiBase}/api/emails/unsubscribe?success=1`, 302);
        break;
      }
      case 'admin/emails':
        resp = await adminEmailsHandler(request);
        break;

      case 'admin/emails/reply':
        resp = await adminEmailReplyHandler(request);
        break;
      case 'admin/email-preview': {
        const adminSess = await requireSession(request);
        if (adminSess instanceof NextResponse) { resp = adminSess; break; }
        const admUser = await prisma.user.findUnique({ where: { id: adminSess.userId }, select: { isAdmin: true } });
        if (!admUser?.isAdmin) { resp = jsonForbidden('Admin only'); break; }
        const epUrl = new URL(request.url);
        const epTemplate = epUrl.searchParams.get('template') || 'welcome';
        const { getFallbackTemplates } = await import('@/features/email/email');
        const templates = await getFallbackTemplates();
        const tmpl = templates[epTemplate];
        if (tmpl) {
          const { renderTemplate } = await import('@/features/email/email');
          // One shared manifest — see features/email/sample-vars.ts. This
          // block used to carry its own 44-name list that had drifted out of
          // sync with the catalogue: 60 of 91 real placeholders were missing,
          // so previews rendered literal {{submissionId}} to the admin.
          const { sampleVars: buildSampleVars } = await import(
            '@/features/email/sample-vars'
          );
          const sampleVars = buildSampleVars({
            accountsUrl: getAccountsBaseUrl(),
            dashboardUrl: getDashboardBaseUrl(),
            adminUrl: getAdminBaseUrl() });
          const html = renderTemplate(tmpl.html, sampleVars);
          resp = NextResponse.json({ html });
        } else {
          resp = NextResponse.json({ error: `Template '${epTemplate}' not found` }, { status: 404 });
        }
        break;
      }
      case 'emails': {
        const emSession = await requireSession(request);
        if (emSession instanceof NextResponse) { resp = emSession; break; }
        const { prisma: emPrisma } = await import('@/infrastructure/db/prisma');
        const emUrl = new URL(request.url);
        const emLimit = Math.min(parseInt(emUrl.searchParams.get('limit') || '50', 10), 200);
        const emOffset = parseInt(emUrl.searchParams.get('offset') || '0', 10);
        const emUser = await emPrisma.user.findUnique({ where: { id: emSession.userId }, select: { isAdmin: true } });
        // User.email/role are gone — admins see every job, everyone else only
        // their own email jobs (userId covers all of a user's addresses).
        const emWhere: any = emUser?.isAdmin ? {} : { userId: emSession.userId };
        const [emItems, emTotal] = await Promise.all([
          emPrisma.email_jobs.findMany({ where: emWhere, orderBy: { createdAt: 'desc' }, take: emLimit, skip: emOffset }),
          emPrisma.email_jobs.count({ where: emWhere }),
        ]);
        resp = NextResponse.json({ items: emItems, total: emTotal, limit: emLimit, offset: emOffset });
        break;
      }
      case 'emails/unsubscribe': {
        const euUrl = new URL(request.url);
        const euSuccess = euUrl.searchParams.get('success') === '1';
        const euError = euUrl.searchParams.get('error') || '';
        const euPrefill = euUrl.searchParams.get('email') || '';
        const euToken = euUrl.searchParams.get('token') || '';
        if (request.method === 'GET') {
          const escH = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

          const checkIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`;
          const mailIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#666666" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`;

          let bodyContent = '';
          if (euSuccess) {
            bodyContent = `
              <div style="margin-bottom:20px">${checkIcon}</div>
              <h1 style="font-size:18px;font-weight:600;margin-bottom:10px;color:#fafafa;letter-spacing:-0.01em">Unsubscribed</h1>
              <p style="font-size:13px;color:#666666;line-height:1.7;margin-bottom:0">You won't receive non-essential emails anymore.<br/>Security alerts are always sent.</p>`;
          } else if (!euToken) {
            // No token means the visitor arrived without an email link — do NOT
            // let them mute an account by typing an arbitrary address. They must
            // use the signed link from their own inbox.
            bodyContent = `
              <div style="margin-bottom:20px">${mailIcon}</div>
              <h1 style="font-size:18px;font-weight:600;margin-bottom:10px;color:#fafafa;letter-spacing:-0.01em">Unsubscribe from emails</h1>
              <p style="font-size:13px;color:#666666;line-height:1.7;margin-bottom:28px">Use the unsubscribe link that was sent to your email.</p>
              ${euError ? `<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:10px 14px;margin-bottom:20px;color:#f87171;font-size:12px">${escH(euError)}</div>` : ''}`;
          } else {
            bodyContent = `
              <div style="margin-bottom:20px">${mailIcon}</div>
              <h1 style="font-size:18px;font-weight:600;margin-bottom:10px;color:#fafafa;letter-spacing:-0.01em">Unsubscribe from emails</h1>
              <p style="font-size:13px;color:#666666;line-height:1.7;margin-bottom:28px">Enter your email to stop receiving non-essential emails.</p>
              ${euError ? `<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:10px 14px;margin-bottom:20px;color:#f87171;font-size:12px">${escH(euError)}</div>` : ''}
              <form method="POST" action="/api/emails/unsubscribe">
                <input type="hidden" name="token" value="${escH(euToken)}" />
                <input id="eu-email" type="email" name="email" placeholder="you@example.com" value="${escH(euPrefill)}" required autocomplete="email" style="width:100%;padding:11px 14px;background:#000000;border:1px solid #222222;border-radius:8px;font-size:14px;color:#ffffff;outline:none;transition:border-color .15s;margin-bottom:14px" onfocus="this.style.borderColor='#444444'" onblur="this.style.borderColor='#222222'" />
                <button type="submit" style="width:100%;padding:11px;background:#ffffff;color:#000000;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">Unsubscribe</button>
              </form>`;
          }

          const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Unsubscribe</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#000;color:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;-webkit-font-smoothing:antialiased}</style></head><body><div style="max-width:380px;width:100%;padding:40px 32px;text-align:center">${bodyContent}<div style="margin-top:36px;padding-top:20px;border-top:1px solid #111111;font-size:11px;color:#444444;line-height:1.7"><a href="https://tirbeo.com" style="color:#666666;text-decoration:none">tirbeo.com</a></div></div></body></html>`;
          resp = new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        } else {
          // POST — process email-based unsubscribe. REQUIRES a valid signed
          // token (proof the caller owns this inbox) + a matching email.
          try {
            const ct = request.headers.get('content-type') || '';
            let euAddr = '';
            let euTokenIn = euToken;
            if (ct.includes('application/json')) {
              const body: any = await request.json();
              euAddr = (body.email || '').trim().toLowerCase();
              euTokenIn = euTokenIn || (body.token || '');
            } else if (ct.includes('multipart/form-data')) {
              const fd = await request.formData();
              euAddr = (fd.get('email') as string || '').trim().toLowerCase();
              euTokenIn = euTokenIn || (fd.get('token') as string || '');
            } else {
              const txt = await request.text();
              const m = txt.match(/email=([^&]+)/);
              if (m) euAddr = decodeURIComponent(m[1]).trim().toLowerCase();
              const tm = txt.match(/token=([^&]+)/);
              if (tm) euTokenIn = euTokenIn || decodeURIComponent(tm[1]).trim();
            }

            if (!euTokenIn) {
              resp = NextResponse.redirect(`${euUrl.origin}/api/emails/unsubscribe?error=This+link+is+missing+its+authorization+token.+Please+use+the+link+from+your+email.`, 302);
            } else {
              const { verifyUnsubscribeToken } = await import('@/features/email/emailPrefs');
              const decoded = verifyUnsubscribeToken(euTokenIn);
              if (!decoded) {
                resp = NextResponse.redirect(`${euUrl.origin}/api/emails/unsubscribe?error=This+unsubscribe+link+is+invalid+or+has+expired.+Please+use+the+link+from+a+recent+email.`, 302);
              } else if (!euAddr || !euAddr.includes('@')) {
                resp = NextResponse.redirect(`${euUrl.origin}/api/emails/unsubscribe?token=${encodeURIComponent(euTokenIn)}&email=${encodeURIComponent(euAddr)}&error=Please+enter+a+valid+email+address`, 302);
              } else {
                // Bind the token to the address: the token is for a specific
                // account, so an address that isn't one of the account's
                // recorded emails means it's the wrong inbox. (User.email is
                // gone — addresses live in user_email now.)
                const euMatch = await prisma.userEmail.findFirst({
                  where: { userId: decoded.userId, address: euAddr },
                  select: { id: true } });
                if (!euMatch) {
                  resp = NextResponse.redirect(`${euUrl.origin}/api/emails/unsubscribe?error=This+link+belongs+to+a+different+email+address.`, 302);
                } else {
                  const { processUnsubscribe } = await import('@/features/email/emailPrefs');
                  await processUnsubscribe(decoded.userId, decoded.category);
                  console.log(`[EMAIL/UNSUBSCRIBE] ${euAddr} unsubscribed (signed token)`);
                  const apiBase = process.env.NEXT_PUBLIC_API_URL || 'https://api.tirbeo.com';
                  resp = NextResponse.redirect(`${apiBase}/api/emails/unsubscribe?success=1`, 302);
                }
              }
            }
          } catch (err: any) {
            console.error('[EMAIL/UNSUBSCRIBE] Error:', err?.message);
            resp = NextResponse.redirect(`${euUrl.origin}/api/emails/unsubscribe?error=` + encodeURIComponent('Something went wrong. Please try the link again.'), 302);
          }
        }
        break;
      }
      case 'pushes': {
        const psSession = await requireSession(request);
        if (psSession instanceof NextResponse) { resp = psSession; break; }
        // Push registrations ride in the notification-preference blob; read them
        // through the merged view so they show up whichever store the write landed in.
        const { loadNotificationPrefs } = await import('@/features/notifications/notifications');
        const psPrefs: any = await loadNotificationPrefs(psSession.userId);
        const psSubs = psPrefs.pushSubscriptions || [];
        const psItems = psSubs.map((sub: any, i: number) => ({
          id: i, endpoint: sub.endpoint ? `${sub.endpoint.slice(0, 30)}...` : 'unknown',
          createdAt: sub.createdAt || null, userAgent: sub.userAgent || null, enabled: sub.enabled !== false }));
        resp = NextResponse.json({ items: psItems, total: psItems.length });
        break;
      }
      case 'public/help-config':
      case 'public/faq':
        resp = NextResponse.json({ articles: [] });
        break;
      case 'districts':
        resp = NextResponse.json({ districts: [] });
        break;
      case 'developer/api-keys':
        resp = await apiKeysHandler(request);
        break;
      case 'developer/api-keys/[id]':
        resp = await apiKeyDeleteHandler(request, (route as any).meta.keyId);
        break;
      case 'admin/reserved-addresses/[id]':
        resp = NextResponse.json({ error: 'Not implemented' }, { status: 501 });
        break;

      case 'admin/oauth/apps':
      case 'admin/oauth/apps/[id]':
      case 'admin/oauth/clients':
      case 'admin/oauth/clients/[id]':
      case 'admin/oauth/clients/[id]/secret':
      case 'admin/help-articles':
      case 'admin/help-articles/[id]':
      case 'admin/integrations':
      case 'admin/settings':
      case 'auth/oauth/authorize':
      case 'auth/oauth/token':
      case 'auth/oauth/revoke':
      case 'oidc/userinfo':
      case 'content/settings':
      case 'content/settings/update':
      case 'content/feature-flags':
      case 'content/feature-flags/update':
      case 'content/jobs':
      case 'content/jobs/create':
      case 'content/retry-job/[id]':
      case 'support/queues':
      case 'support/queues/create':
        resp = NextResponse.json({ error: 'Feature removed' }, { status: 410 });
        break;

      case 'admin/analytics/overview':
        resp = await adminAnalyticsOverviewHandler(request);
        break;
      case 'admin/analytics/consented-users':
        resp = await adminAnalyticsConsentedUsersHandler(request);
        break;

      // admin/maintenance handled by standalone route at app/api/admin/maintenance/

// connected-accounts routes removed (LinkedAccount model removed)
      case 'user/export-data':
        resp = await exportDataHandler(request);
        break;
      case 'user/delete-account':
        resp = await deleteAccountRequestHandler(request);
        break;
      case 'profile/public':
        resp = await publicProfileHandler(request);
        break;
      case 'auth/cli-token':
        resp = await cliTokenHandler(request);
        break;

      case 'chat':
        resp = await chatHandler(request);
        break;

      case 'waitlist':
        resp = NextResponse.json({ ok: true, message: 'Waitlist feature coming soon' });
        break;
      case 'feedback':
        resp = NextResponse.json({ ok: true, message: 'Feedback received' });
        break;
      case 'admin/feedback':
        resp = NextResponse.json({ feedback: [] });
        break;
      case 'admin/subscribers':
        resp = NextResponse.json({ subscribers: [] });
        break;
      case 'user/apps':
        resp = await userAppsHandler(request);
        break;
      case 'user/overview':
        resp = await userOverviewHandler(request);
        break;
      case 'auth/verify':
        resp = await verifyHandler(request);
        break;

      case 'email/templates/[name]':
        resp = await emailTemplateDetailHandler(request, (route as any).meta.templateName);
        break;
      case 'admin/emails/[id]':
        resp = await adminEmailDetailHandler(request, (route as any).meta.emailId);
        break;
      case 'content/incident-events':
      case 'support/tickets':
      case 'support/tickets/create':
      case 'support/appeal':
        resp = await appealFileHandler(request);
        break;
      case 'support/tickets/appeals':
        resp = await appealsListHandler(request);
        break;
      case 'support/tickets/[id]':
      case 'support/tickets/[id]/messages':
      case 'support/tickets/[id]/reply':
      case 'support/tickets/[id]/read':
      case 'support/tickets/[id]/assign':
      case 'support/tickets/[id]/close':
      case 'support/tickets/[id]/reopen':
      case 'support/tickets/[id]/attachments':
      case 'support/tickets/[id]/attachments/[attachmentId]':
        resp = NextResponse.json({ error: 'Feature removed' }, { status: 410 });
        break;
      case 'health':
        resp = await publicHealthHandler();
        break;
      case 'health/pool':
        resp = await poolHealthHandler(request);
        break;
      case 'debug/cache':
        resp = await cacheDebugHandler(request);
        break;
      case 'debug/cache/reset':
        resp = await cacheResetDebugHandler(request);
        break;
      case 'debug/query-perf':
        resp = await queryPerfDebugHandler(request);
        break;
      case 'debug/query-perf/reset':
        resp = await queryPerfResetDebugHandler(request);
        break;
      case 'debug/query-perf/config':
        resp = (method.toUpperCase() === 'PUT')
          ? await queryPerfConfigUpdateDebugHandler(request)
          : await queryPerfConfigDebugHandler(request);
        break;
      case 'debug/rate-limits/reset': {
        // Admin-gated (mirrors every other debug/* handler).
        const { requireDebugAccess } = await import('@/features/admin/debugHandlers');
        const denied = await requireDebugAccess(request);
        if (denied) { resp = denied; break; }
        const { clearRateLimits } = await import('@/features/captcha/risk');
        clearRateLimits();
        resp = NextResponse.json({ success: true, message: 'Rate limits cleared' });
        break;
      }
      case 'content/health':
        resp = await detailedHealthHandler(request);
        break;

      // Workspace routes
      default:
        resp = NextResponse.json({ error: 'Internal route not implemented' }, { status: 501 });
    }
    } catch (err: any) {
      console.error(`[HANDLER] Internal route ${route.path} error:`, err?.message || err, err?.stack);
      // Typed event ID ("SY" — system fault) so users can reference this
      // exact 500 and staff can correlate it with server logs.
      const syEventId = generateEventId('system');
      console.error(`[HANDLER] System event ID for ${method} ${pathStr}: ${syEventId}`);
      resp = NextResponse.json(
        { error: 'Internal server error', eventId: syEventId },
        { status: 500, headers: { 'X-Event-Id': syEventId } },
      );
    }
    await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: resp.status });
    return addRateLimitHeaders(resp);
  }

  let userRole = 'guest';
  if (session?.userId) {
    try {
      // adminRole string is gone — the consolidated schema has a boolean.
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { isAdmin: true } });
      userRole = user?.isAdmin ? 'admin' : 'member';
    } catch (e: any) {
      console.error('[HANDLER] DB query failed during role lookup:', e?.message);
      userRole = 'guest';
    }
  }
  if (!route.allowedRoles.includes(userRole)) {
    await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: 403 });
    return jsonForbidden(`Your role '${userRole}' does not have access to this resource`);
  }

  let targetUrl: string;
  if (route.target) {
    const parsedTarget = new URL(route.target);
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', 'metadata.google.internal', 'metadata.internal', '100.100.100.200', '::1'];
    const blockedIpRanges = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^fe80:/i, /^fc/i, /^fd/i, /^::1$/];
    const hostname = parsedTarget.hostname.toLowerCase();
    const isTrustedTarget = trustedInternalOrigins().has(parsedTarget.origin);
    if (!isTrustedTarget) {
      if (blockedHosts.includes(hostname) || blockedIpRanges.some(r => r.test(hostname))) {
        await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: 403 });
        return jsonForbidden('Proxy target not allowed');
      }
      if (/^[a-z0-9.-]+$/i.test(hostname) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
        try {
          const { lookup } = await import('node:dns/promises');
          const resolved = await lookup(hostname, { all: true });
          const isPrivate = resolved.some(({ address }) =>
            blockedHosts.includes(address) ||
            blockedIpRanges.some(r => r.test(address))
          );
          if (isPrivate) {
            await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: 403 });
            return jsonForbidden('Proxy target not allowed');
          }
        } catch (e: any) {
          await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: 400 });
          return jsonError('Proxy target could not be resolved', 400);
        }
      }
    }
    targetUrl = `${route.target}${request.nextUrl.search}`;
  } else {      const [subdomain, ...rest] = route.path.split('/');
    const targetBase = appUrl(subdomain, '/' + rest.join('/'));
    targetUrl = `${targetBase}${request.nextUrl.search}`;
  }

  const init: RequestInit = {
    method,
    headers: {
      ...(session?.userId && { 'x-user-id': session.userId }),
      'content-type': request.headers.get('content-type') || '' },
    body: method !== 'GET' && method !== 'HEAD' ? await request.text() : undefined };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl, { ...init, signal: controller.signal });
  } catch (e: any) {
    clearTimeout(timeout);
    if (e?.name === 'AbortError') {
      await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: 504 });
      return NextResponse.json({ error: 'Gateway timeout — upstream server did not respond in time' }, { status: 504 });
    }
    throw e;
  }
  clearTimeout(timeout);
  const responseHeaders = new Headers(upstreamResponse.headers);
  const response = new NextResponse(await upstreamResponse.text(), {
    status: upstreamResponse.status,
    headers: responseHeaders });

  await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: upstreamResponse.status });
  return addRateLimitHeaders(response);
}
