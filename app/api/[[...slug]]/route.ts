import { NextResponse, NextRequest } from 'next/server';
import { prisma, isDbHealthy, dbErrorResponse } from '../../../lib/db/prisma';
import { getSession, requireSession, isAdmin } from '@/lib/session';
import { logRequest } from '../../../lib/logger';
import { jsonError, jsonForbidden, jsonUnauthorized } from '../../../lib/response';
import { checkRateLimitWithInfo, ROUTE_LIMITS, type RateLimitResult } from '../../../lib/auth/rate-limit';

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
  requestPhoneOtpHandler,
  verifyPhoneOtpHandler,
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
  verifyMagicLinkHandler,
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
   sessionRevokeByTokenHandler,
 } from '../../../lib/authHandlers';

import {
  captchaChallengeHandler,
  captchaVerifyHandler,
  captchaStatusHandler,
  captchaImageHandler,
} from '../../../lib/captcha/captcha-dispatch';

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
  preferencesHandler,
  consentHistoryHandler,
  setPasswordHandler,
  requestProfileEditOtpHandler,
  verifyProfileEditOtpHandler,
  avatarUploadHandler,
  heartbeatHandler,
  notificationPrefsHandler,
  notificationChannelsHandler,
  notificationCategoriesHandler,
  notificationDigestHandler,
  notificationTipsHandler,
  exportDataHandler,
  deleteAccountRequestHandler,
  publicProfileHandler,
} from '../../../lib/userHandlers';

import {
  emailConfigHandler,
  emailTemplatesHandler,
  emailTemplateDetailHandler,
  emailTestHandler,
  adminEmailsHandler,
  adminEmailReplyHandler,
  adminEmailDetailHandler,
} from '../../../lib/emailAdminHandlers';

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
  phonesSendOtpHandler,
  phonesVerifyOtpHandler,
  recoveryEmailHandler,
  recoveryEmailSendCodeHandler,
  recoveryEmailVerifyHandler,
  passwordCheckHandler,
  sessionsRevokeAllHandler,
  sessionRevokeHandler,
} from '../../../lib/securityHandlers';

import {
  apiKeysHandler,
  apiKeyDeleteHandler,
} from '../../../lib/developerHandlers';

import {
  chatHandler,
} from '../../../lib/authHandlers';

// oauthAdminHandlers removed — OAuth2 server models deleted

import {
  knownAccountsHandler,
  switchAccountHandler,
  removeKnownAccountHandler,
} from '../../../lib/accountSwitchHandlers';

// connectedAccountsHandler removed (LinkedAccount model removed)

import {
  passkeyRegisterOptionsHandler,
  passkeyRegisterVerifyHandler,
  passkeyAuthOptionsHandler,
  passkeyAuthVerifyHandler,
  passkeyListHandler,
  passkeyDeleteHandler,
  passkeyUpdateHandler,
} from '../../../lib/passkeyHandlers';

import {
  incidentEventsListHandler, incidentEventsCreateHandler,
} from '../../../lib/contentHandlers';

import { adminAnalyticsOverviewHandler } from '../../../lib/adminAnalytics';
import { adminAnalyticsConsentedUsersHandler } from '../../../lib/adminAnalyticsHandlers';
import { adminMaintenanceHandler } from '../../../lib/adminHandlers';

import {
  ticketListHandler, ticketCreateHandler, ticketDetailHandler, ticketUpdateHandler,
  ticketMessageHandler, ticketAssignHandler, ticketCloseHandler, ticketReopenHandler,
  ticketAppealsHandler, ticketAppealUnblockHandler,
  ticketAttachmentsListHandler, ticketAttachmentsUploadHandler,
  ticketAttachmentDownloadHandler,
  ticketMarkReadHandler,
} from '../../../lib/supportHandlers';

import {
  loginHistoryHandler,
} from '../../../lib/securityHandlers';



import {
  publicHealthHandler, detailedHealthHandler, poolHealthHandler,
} from '../../../lib/health';
import {
  cacheDebugHandler, cacheResetDebugHandler,
  queryPerfDebugHandler, queryPerfResetDebugHandler,
  queryPerfConfigDebugHandler, queryPerfConfigUpdateDebugHandler,
} from '../../../lib/debugHandlers';

// jobs module removed

const appUrl = (subdomain: string, path: string) =>
  `https://${subdomain}.${process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app'}${path}`;

const INTERNAL_ROUTES = [
  'auth/login', 'auth/signup', 'auth/email-exists', 'auth/username-exists', 'auth/logout',
  'auth/email-otp/request', 'auth/email-otp/verify',
  'auth/phone-otp/request', 'auth/phone-otp/verify',
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
   'auth/accounts', 'auth/switch-account', 'auth/accounts/remove',
   'security/session-revoke',
   'auth/verify-email', 'auth/verify',
  'captcha/challenge', 'captcha/verify', 'captcha/status', 'captcha/image/[id]',
  'users/me',
  'profile', 'security/password', 'security/sessions', 'security/set-password',
  'security/events', 'security/totp/setup', 'security/totp/verify', 'security/totp/disable',
  'security/backup-codes/list', 'security/backup-codes/regenerate', 'security/phones', 'security/phones/send-otp', 'security/phones/verify-otp', 'security/recovery-email', 'security/recovery-email/send-code', 'security/recovery-email/verify',
  'security/password-check', 'security/sessions/revoke-all', 'security/login-history',
  'profile/request-edit-otp', 'profile/verify-edit-otp', 'profile/avatar', 'profile/check-username',
  'notifications', 'notifications/prefs', 'notifications/prefs/channels', 'notifications/prefs/categories', 'notifications/prefs/digest', 'notifications/prefs/tips', 'integrations', 'integrations/merge', 'user/activity', 'preferences', 'consent-history',
  'admin/heartbeat',
  'email/config', 'email/templates', 'email/test', 'email/unsubscribe',  'admin/emails', 'admin/emails/reply', 'admin/email-preview',
  'emails', 'emails/unsubscribe', 'pushes',
  'districts',
  'developer/api-keys',
  'user/mailbox', 'user/mailbox/check', 'user/mailbox/dns',
  'user/apps',
  'admin/reserved-addresses',
  'admin/groups',
  'admin/ous', 'admin/security/score',
  'admin/settings', 'admin/analytics/overview', 'admin/analytics/consented-users', 'admin/maintenance',
  'passkey/register/options', 'passkey/register/verify',
  'passkey/auth/options', 'passkey/auth/verify',
  'passkey/list',
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
  'support/tickets', 'support/tickets/create',  'support/tickets/appeals',


];

let blockCache: { data: any[]; ts: number } | null = null;
const CACHE_TTL = 60000; // 60s cache for blocks — stale-while-revalidate pattern
const STALE_TTL = 300_000; // serve stale data for up to 5 min if DB is down

async function loadBlocked() {
  if (blockCache && Date.now() - blockCache.ts < CACHE_TTL) return blockCache.data;
  try {
    const data = await prisma.blocklist.findMany();
    blockCache = { data, ts: Date.now() };
    return data;
  } catch (e: any) {
    console.error('[BLOCKLIST] DB query failed, serving stale cache:', e?.message);
    // Serve stale cache if available instead of failing
    if (blockCache && Date.now() - blockCache.ts < STALE_TTL) return blockCache.data;
    return [];
  }
}

function matchRoute(slug: string[], method: string) {
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

  // Handle passkey/{id} dynamic route (only DELETE/PATCH on non-static subpaths)
  if (slug.length === 2 && slug[0] === 'passkey') {
    const passkeyId = slug[1];
    const PASSKEY_STATIC = ['register', 'auth', 'list'];
    if (!PASSKEY_STATIC.includes(passkeyId)) {
      if (method.toUpperCase() === 'DELETE') {
        return { path: 'passkey/[id]', method: 'DELETE', internal: true, allowedRoles: ['guest'], meta: { passkeyId } };
      }
      if (method.toUpperCase() === 'PATCH') {
        return { path: 'passkey/[id]', method: 'PATCH', internal: true, allowedRoles: ['guest'], meta: { passkeyId } };
      }
    }
  }

  // Handle content/retry-job/{id} dynamic route
  if (slug.length === 3 && slug[0] === 'content' && slug[1] === 'retry-job') {
    return { path: 'content/retry-job/[id]', method: 'POST', internal: true, allowedRoles: ['guest'], meta: { retryJobId: slug[2] } };
  }

  // Handle support/tickets/{id} dynamic route (GET/PATCH/PUT/DELETE)
  if (slug.length === 3 && slug[0] === 'support' && slug[1] === 'tickets') {
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

  // Handle support/tickets/appeals/{rayId}/unblock
  if (slug.length === 5 && slug[0] === 'support' && slug[1] === 'tickets' && slug[2] === 'appeals' && slug[4] === 'unblock') {
    return { path: 'support/tickets/appeals/[rayId]/unblock', method, internal: true, allowedRoles: ['guest'], meta: { appealRayId: slug[3] } };
  }

  // Handle captcha/image/{id} dynamic route
  if (slug.length === 3 && slug[0] === 'captcha' && slug[1] === 'image') {
    const imageId = slug[2];
    return { path: 'captcha/image/[id]', method, internal: true, allowedRoles: ['guest'], meta: { imageId } };
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
      'captcha/challenge': ['GET', 'POST'],
      'captcha/verify': ['POST'],
      'captcha/status': ['GET'],
      'captcha/image/[id]': ['GET'],
      'auth/email-otp/request': ['POST'],
      'auth/email-otp/verify': ['POST'],
      'auth/phone-otp/request': ['POST'],
      'auth/phone-otp/verify': ['POST'],
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
       'auth/accounts': ['GET'],
       'auth/switch-account': ['POST'],
       'auth/accounts/remove': ['POST'],
        'security/session-revoke': ['POST'],
       'users/me': ['GET', 'PATCH'],
      'profile': ['GET', 'PATCH', 'PUT'],
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
      'security/phones/send-otp': ['POST'],
      'security/phones/verify-otp': ['POST'],
      'security/recovery-email': ['PUT'],
      'security/recovery-email/send-code': ['POST'],
      'security/recovery-email/verify': ['POST'],
      'security/login-history': ['GET'],
      'security/password-check': ['POST'],
      'security/sessions/revoke-all': ['DELETE'],
      'profile/request-edit-otp': ['POST'],
      'profile/verify-edit-otp': ['POST'],
      'profile/avatar': ['POST'],
      'notifications': ['GET', 'PATCH', 'DELETE'],
      'notifications/prefs': ['GET', 'PUT'],
      'notifications/prefs/channels': ['GET', 'PUT'],
      'notifications/prefs/categories': ['GET', 'PUT'],
      'notifications/prefs/digest': ['GET', 'PUT'],
      'notifications/prefs/tips': ['GET', 'PUT'],
      'integrations': ['GET', 'POST', 'DELETE'],
      'integrations/merge': ['POST'],

      'user/activity': ['GET'],
      'preferences': ['GET', 'PATCH'],
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
      'emails/unsubscribe': ['GET', 'POST'],
      'pushes': ['GET'],
      'districts': ['GET'],
      'developer/api-keys': ['GET', 'POST'],
      'user/mailbox': ['GET', 'POST', 'PUT', 'DELETE'],
      'user/mailbox/check': ['GET'],
      'user/mailbox/dns': ['GET'],
      'user/apps': ['GET', 'POST', 'PUT', 'DELETE'],
      'admin/reserved-addresses': ['GET', 'POST'],
      'admin/groups': ['GET', 'POST'],
      'admin/ous': ['GET', 'POST'],
      'admin/security/score': ['GET'],
      'admin/settings': ['GET', 'PATCH'],
      'admin/maintenance': ['GET', 'POST'],
      'admin/analytics/overview': ['GET'],
      'admin/analytics/consented-users': ['GET'],
      'passkey/register/options': ['POST'],
      'passkey/register/verify': ['POST'],
      'passkey/auth/options': ['POST'],
      'passkey/auth/verify': ['POST'],
      'passkey/list': ['GET'],
      // connected-accounts removed — OAuth IDs stored on users table directly
      'user/export-data': ['GET', 'POST'],
      'user/delete-account': ['POST', 'DELETE'],
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
      'support/tickets/[id]/read': ['POST'],
      'support/tickets/[id]/attachments': ['GET', 'POST'],
      'support/tickets/[id]/attachments/[attachmentId]': ['GET'],
      'support/tickets/appeals': ['GET'],


    };
    const allowed = methodMap[pathPart];
    if (allowed && allowed.includes(method.toUpperCase())) {
      return { path: pathPart, method, internal: true, allowedRoles: ['guest'] };
    }
  }
  return undefined;
}

function isBlocked(ip?: string, userId?: string, blocked: any[] = []) {
  return blocked.some((entry: any) =>
    (entry.type === 'ip' && entry.value === ip) ||
    (entry.type === 'user' && entry.value === userId)
  );
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return handler(request, slug, 'GET');
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return handler(request, slug, 'POST');
}
export async function PUT(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return handler(request, slug, 'PUT');
}
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return handler(request, slug, 'DELETE');
}
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return handler(request, slug, 'PATCH');
}

async function handler(request: NextRequest, slug: string[], method: string) {
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
      console.warn(`[AUTH] API key auth FAILED — header present but no valid key found, path: ${pathStr}, method: ${method}`);
    }
  } catch (e: any) {
    console.error('[HANDLER] getSession failed:', e?.message);
  }

  let routes: any[] = [];
  let blocked: any[] = [];
  try {
    blocked = await loadBlocked();
  } catch (e: any) {
    console.error('[HANDLER] loadBlocked failed:', e?.message);
    return NextResponse.json({ error: 'Database connection error' }, { status: 500 });
  }

  if (isBlocked(ip, session?.userId, blocked)) {
    console.warn(`[AUTH] Blocked request — ip: ${ip}, user: ${session?.userId}, path: ${pathStr}`);
    await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: 403 });
    return jsonForbidden('Your IP or account has been blocked');
  }

  // Redirect user-facing paths to the dashboard instead of returning 404.
  // The API server only serves /api/* routes; pages live on dashboard.tirbeo.app.
  // Skip paths that are registered internal API routes (e.g. support/tickets).
  if (!pathStr || pathStr.startsWith('account') || pathStr.startsWith('settings') || pathStr.startsWith('overview') || pathStr.startsWith('support')) {
    const isInternal = INTERNAL_ROUTES.some((r) => pathStr === r || pathStr.startsWith(r + '/'));
    if (!isInternal) {
      const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
      const dashboardBase = `https://dashboard.${appDomain}`;
      if (!pathStr) {
        return NextResponse.json({
          service: 'Tirbeo API',
          status: 'healthy',
          docs: '/api/health',
          dashboard: dashboardBase,
          accounts: `https://accounts.${appDomain}`,
        });
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
    'health', 'health/pool', 'captcha/status', 'captcha/challenge',
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
      case 'auth/phone-otp/request':
        resp = await requestPhoneOtpHandler(request);
        break;
      case 'auth/phone-otp/verify':
        resp = await verifyPhoneOtpHandler(request);
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
      case 'security/phones/send-otp':
        resp = await phonesSendOtpHandler(request);
        break;
      case 'security/phones/verify-otp':
        resp = await phonesVerifyOtpHandler(request);
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
      case 'notifications/prefs/digest':
        resp = await notificationDigestHandler(request);
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
        const { verifyUnsubscribeToken, processUnsubscribe } = await import('../../../lib/emailPrefs');
        const decoded = verifyUnsubscribeToken(token);
        if (!decoded) {
          resp = NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 });
          break;
        }
        await processUnsubscribe(decoded.userId, decoded.category);
        const apiBase = process.env.NEXT_PUBLIC_API_URL || 'https://api.tirbeo.app';
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
        const { isAdmin: checkAdmin } = await import('@/lib/session');
        const admUser = await prisma.user.findUnique({ where: { id: adminSess.userId }, select: { adminRole: true } });
        if (!admUser?.adminRole) { resp = jsonForbidden('Admin only'); break; }
        const epUrl = new URL(request.url);
        const epTemplate = epUrl.searchParams.get('template') || 'welcome';
        const { getFallbackTemplates } = await import('@/lib/email');
        const templates = await getFallbackTemplates();
        const tmpl = templates[epTemplate];
        if (tmpl) {
          const { renderTemplate } = await import('@/lib/email');
          const sampleVars: Record<string, string> = {
            name: 'John Doe', email: 'john@example.com', otp: '123456',
            dashboardUrl: 'https://tirbeo.app', adminUrl: 'https://admin.tirbeo.app',
            loginUrl: 'https://accounts.tirbeo.app/login', resetUrl: 'https://accounts.tirbeo.app/reset',
            magicLink: 'https://accounts.tirbeo.app/auth/magic/abc',
            recoveryUrl: 'https://accounts.tirbeo.app/recover/abc',
            formTitle: 'Contact Form', formUrl: 'https://forms.tirbeo.app/form/abc',
            respondentName: 'Jane Doe', submittedAt: 'Aug 25, 2026, 2:05 PM UTC',
            ticketId: 'TKT-001', ticketSubject: 'Login issue', ticketStatus: 'open',
            ticketUrl: 'https://tirbeo.app/support/tickets/abc',
            subject: 'Test Alert', message: 'This is a test alert.', details: '<p>Details here</p>',
            service: 'PostgreSQL', alertTime: 'Aug 25, 2026, 2:05 PM UTC',
            location: 'New York, US', device: 'Chrome on macOS', loginTime: 'Aug 25, 2026, 2:05 PM UTC',
            ipAddress: '192.168.1.1', revokeUrl: 'https://tirbeo.app/account/sessions',
            changedAt: 'Aug 25, 2026, 2:05 PM UTC',
            company: 'Acme Inc', companyName: 'Acme Inc',
            adminRole: 'admin', temporaryPassword: 'Temp123!',
            title: 'New Feature: Real-time Notifications',
            ctaUrl: 'https://tirbeo.app/overview', ctaLabel: 'Try it now',
            count: '5', digestItems: '<div style="padding:12px;background:#f8f9fa;border-radius:8px;"><strong>New submission</strong></div>',
            periodLabel: 'Aug 19 – Aug 25, 2026',
            statRows: '<div style="padding:12px 0;"><strong>Logins:</strong> 12<br/><strong>Submissions:</strong> 47</div>',
            suspiciousSection: '',
            tipTitle: 'Enable Two-Factor Authentication', tipBody: 'Secure your account.',
            actionUrl: 'https://tirbeo.app/account/security',
            statusType: 'suspended', reason: 'Violation of terms', untilLabel: 'Until further notice.',
            dateLabel: 'Sep 25, 2026',
            updateMessage: "We're looking into your issue.",
            responseId: 'resp_abc', answers: '<div><strong>Name:</strong> Jane</div>',
            submissionData: '<div><strong>Name:</strong> Jane<br/><strong>Email:</strong> jane@example.com</div>',
            rejectionReason: 'Insufficient documentation',
            requestId: 'REQ-001', requestedRole: 'admin',
            flowsUrl: 'https://flows.tirbeo.app',
            flowName: 'My Flow', errorMessage: 'Connection timeout', failedAt: 'Aug 25, 2026',
            duration: '2.3s', stepsExecuted: '5',
            connectionName: 'Google OAuth', expiresAt: 'Sep 25, 2026', affectedFlows: 'My Flow',
            connectionsUrl: 'https://flows.tirbeo.app/connections',
            plan: 'Pro', amount: '$29/mo', date: 'Aug 25, 2026',
            exportedAt: 'Aug 25, 2026', downloadUrl: 'https://tirbeo.app/download',
            milestone: '100',
            responseCount: '23', totalResponses: '156',
            webhookUrl: 'https://example.com/webhook', httpStatus: '500',
            webhookFailedReason: 'Connection timeout',
            role: 'editor', addedByName: 'Admin',
            limit: '1000', settingsUrl: 'https://tirbeo.app/account/preferences',
            logins: '12', submissions: '47',
          };
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
        const { prisma: emPrisma } = await import('@/lib/db/prisma');
        const emUrl = new URL(request.url);
        const emLimit = Math.min(parseInt(emUrl.searchParams.get('limit') || '50', 10), 200);
        const emOffset = parseInt(emUrl.searchParams.get('offset') || '0', 10);
        const emUser = await emPrisma.user.findUnique({ where: { id: emSession.userId }, select: { email: true, role: true } });
        const emWhere: any = emUser?.role === 'admin' ? {} : { toEmail: emUser?.email };
        const [emItems, emTotal] = await Promise.all([
          emPrisma.email_logs.findMany({ where: emWhere, orderBy: { createdAt: 'desc' }, take: emLimit, skip: emOffset }),
          emPrisma.email_logs.count({ where: emWhere }),
        ]);
        resp = NextResponse.json({ items: emItems, total: emTotal, limit: emLimit, offset: emOffset });
        break;
      }
      case 'emails/unsubscribe': {
        const euUrl = new URL(request.url);
        const euSuccess = euUrl.searchParams.get('success') === '1';
        const euError = euUrl.searchParams.get('error') || '';
        const euPrefill = euUrl.searchParams.get('email') || '';
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
          } else {
            bodyContent = `
              <div style="margin-bottom:20px">${mailIcon}</div>
              <h1 style="font-size:18px;font-weight:600;margin-bottom:10px;color:#fafafa;letter-spacing:-0.01em">Unsubscribe from emails</h1>
              <p style="font-size:13px;color:#666666;line-height:1.7;margin-bottom:28px">Enter your email to stop receiving non-essential emails.</p>
              ${euError ? `<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:10px 14px;margin-bottom:20px;color:#f87171;font-size:12px">${escH(euError)}</div>` : ''}
              <form method="POST" action="/api/emails/unsubscribe">
                <input id="eu-email" type="email" name="email" placeholder="you@example.com" value="${escH(euPrefill)}" required autocomplete="email" style="width:100%;padding:11px 14px;background:#000000;border:1px solid #222222;border-radius:8px;font-size:14px;color:#ffffff;outline:none;transition:border-color .15s;margin-bottom:14px" onfocus="this.style.borderColor='#444444'" onblur="this.style.borderColor='#222222'" />
                <button type="submit" style="width:100%;padding:11px;background:#ffffff;color:#000000;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">Unsubscribe</button>
              </form>`;
          }

          const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Unsubscribe</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#000;color:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;-webkit-font-smoothing:antialiased}</style></head><body><div style="max-width:380px;width:100%;padding:40px 32px;text-align:center">${bodyContent}<div style="margin-top:36px;padding-top:20px;border-top:1px solid #111111;font-size:11px;color:#444444;line-height:1.7"><a href="https://tirbeo.app" style="color:#666666;text-decoration:none">tirbeo.app</a></div></div></body></html>`;
          resp = new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        } else {
          // POST — process email-based unsubscribe
          try {
            const ct = request.headers.get('content-type') || '';
            let euAddr = '';
            if (ct.includes('application/json')) {
              const body: any = await request.json();
              euAddr = (body.email || '').trim().toLowerCase();
            } else if (ct.includes('multipart/form-data')) {
              const fd = await request.formData();
              euAddr = (fd.get('email') as string || '').trim().toLowerCase();
            } else {
              const txt = await request.text();
              const m = txt.match(/email=([^&]+)/);
              if (m) euAddr = decodeURIComponent(m[1]).trim().toLowerCase();
            }
            if (!euAddr || !euAddr.includes('@')) {
              resp = NextResponse.redirect(`${euUrl.origin}/api/emails/unsubscribe?error=Please+enter+a+valid+email+address`, 302);
            } else {
              const euUser = await prisma.user.findUnique({ where: { email: euAddr }, select: { id: true, notificationPreferences: true, emailUnsubscribed: true } });
              if (euUser) {
                const prefs: any = (euUser as any).notificationPreferences || {};
                const eu: any = (euUser as any).emailUnsubscribed || {};
                prefs.email = false; prefs.productEmail = false; prefs.formsEmail = false; prefs.supportEmail = false;
                eu.all = true; eu.product = true; eu.forms = true; eu.support = true;
                await prisma.$executeRaw`UPDATE "users" SET "notification_preferences" = ${JSON.stringify(prefs)}::jsonb, "email_unsubscribed" = ${JSON.stringify(eu)}::jsonb WHERE "id" = ${euUser.id}`;
                console.log(`[EMAIL/UNSUBSCRIBE] ${euAddr} unsubscribed from all non-essential emails`);
              }
              resp = NextResponse.redirect(`${euUrl.origin}/api/emails/unsubscribe?success=1&email=${encodeURIComponent(euAddr)}`, 302);
            }
          } catch (err: any) {
            console.error('[EMAIL/UNSUBSCRIBE] Error:', err?.message);
            resp = NextResponse.redirect(`${euUrl.origin}/api/emails/unsubscribe?error=Something+went+wrong.+Please+try+again.`, 302);
          }
        }
        break;
      }
      case 'pushes': {
        const psSession = await requireSession(request);
        if (psSession instanceof NextResponse) { resp = psSession; break; }
        const { prisma: psPrisma } = await import('@/lib/db/prisma');
        const psUser = await psPrisma.user.findUnique({ where: { id: psSession.userId }, select: { notificationPreferences: true } });
        const psPrefs: any = (psUser as any)?.notificationPreferences || {};
        const psSubs = psPrefs.pushSubscriptions || [];
        const psItems = psSubs.map((sub: any, i: number) => ({
          id: i, endpoint: sub.endpoint ? `${sub.endpoint.slice(0, 30)}...` : 'unknown',
          createdAt: sub.createdAt || null, userAgent: sub.userAgent || null, enabled: sub.enabled !== false,
        }));
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
      case 'passkey/register/options':
        resp = await passkeyRegisterOptionsHandler(request);
        break;
      case 'passkey/register/verify':
        resp = await passkeyRegisterVerifyHandler(request);
        break;
      case 'passkey/auth/options':
        resp = await passkeyAuthOptionsHandler(request);
        break;
      case 'passkey/auth/verify':
        resp = await passkeyAuthVerifyHandler(request);
        break;
      case 'passkey/list':
        resp = await passkeyListHandler(request);
        break;
      case 'passkey/[id]':
        if (method === 'DELETE') resp = await passkeyDeleteHandler(request, (route as any).meta.passkeyId);
        else if (method === 'PATCH') resp = await passkeyUpdateHandler(request, (route as any).meta.passkeyId);
        else resp = NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
        break;
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
      case 'user/mailbox':
        resp = NextResponse.json({ mailbox: [] });
        break;
      case 'user/mailbox/check':
        resp = NextResponse.json({ checked: true });
        break;
      case 'user/mailbox/dns':
        resp = NextResponse.json({ records: [] });
        break;
      case 'user/apps':
        resp = NextResponse.json({ apps: [] });
        break;
      case 'auth/verify':
        resp = await verifyHandler(request);
        break;

      case 'auth/oauth/authorize':
      case 'auth/oauth/token':
      case 'auth/oauth/revoke':
      case 'oidc/userinfo':
        resp = NextResponse.json({ error: 'OAuth2/OIDC server removed' }, { status: 410 });
        break;
      case 'email/templates/[name]':
        resp = await emailTemplateDetailHandler(request, (route as any).meta.templateName);
        break;
      case 'admin/emails/[id]':
        resp = await adminEmailDetailHandler(request, (route as any).meta.emailId);
        break;
      // Content routes
      case 'content/settings':
      case 'content/settings/update':
      case 'content/feature-flags':
      case 'content/feature-flags/update':
        resp = NextResponse.json({ error: 'Feature removed' }, { status: 410 });
        break;
      case 'content/incident-events':
        if (method === 'GET') resp = await incidentEventsListHandler(request);
        else if (method === 'POST') resp = await incidentEventsCreateHandler(request);
        else resp = NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
        break;
      case 'content/jobs':
      case 'content/jobs/create':
      case 'content/retry-job/[id]':
        resp = NextResponse.json({ error: 'Job system removed' }, { status: 410 });
        break;
      // Support routes
      case 'support/tickets':
        if (method === 'POST') resp = await ticketCreateHandler(request);
        else resp = await ticketListHandler(request);
        break;
      case 'support/tickets/create':
        resp = await ticketCreateHandler(request);
        break;
      case 'support/tickets/appeals':
        resp = await ticketAppealsHandler(request);
        break;
      case 'support/tickets/appeals/[rayId]/unblock':
        resp = await ticketAppealUnblockHandler(request, (route as any).meta.appealRayId);
        break;
      case 'support/tickets/[id]':
        if (method === 'GET') resp = await ticketDetailHandler(request, (route as any).meta.ticketId);
        else if (method === 'PATCH' || method === 'PUT') resp = await ticketUpdateHandler(request, (route as any).meta.ticketId);
        else resp = NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
        break;
      case 'support/tickets/[id]/messages':
        resp = await ticketMessageHandler(request, (route as any).meta.ticketId);
        break;
      case 'support/tickets/[id]/reply':
        resp = await ticketMessageHandler(request, (route as any).meta.ticketId);
        break;
      case 'support/tickets/[id]/read':
        resp = await ticketMarkReadHandler(request, (route as any).meta.ticketId);
        break;
      case 'support/tickets/[id]/assign':
        resp = await ticketAssignHandler(request, (route as any).meta.ticketId);
        break;
      case 'support/tickets/[id]/close':
        resp = await ticketCloseHandler(request, (route as any).meta.ticketId);
        break;
      case 'support/tickets/[id]/reopen':
        resp = await ticketReopenHandler(request, (route as any).meta.ticketId);
        break;
      case 'support/tickets/[id]/attachments':
        if (method === 'GET') resp = await ticketAttachmentsListHandler(request, (route as any).meta.ticketId);
        else if (method === 'POST') resp = await ticketAttachmentsUploadHandler(request, (route as any).meta.ticketId);
        else resp = NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
        break;
      case 'support/tickets/[id]/attachments/[attachmentId]':
        resp = await ticketAttachmentDownloadHandler(request, (route as any).meta.ticketId, (route as any).meta.attachmentId);
        break;
      case 'support/queues':
      case 'support/queues/create':
        resp = NextResponse.json({ error: 'Queue system removed' }, { status: 410 });
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
        const { clearRateLimits } = await import('../../../lib/captcha/risk');
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
      resp = NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
    await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: resp.status });
    return addRateLimitHeaders(resp);
  }

  let userRole = 'guest';
  if (session?.userId) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { adminRole: true },
      });
      userRole = user?.adminRole?.toLowerCase() || 'member';
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
    targetUrl = `${route.target}${request.nextUrl.search}`;
  } else {
    const [subdomain, ...rest] = route.path.split('/');
    const targetBase = appUrl(subdomain, '/' + rest.join('/'));
    targetUrl = `${targetBase}${request.nextUrl.search}`;
  }

  const init: RequestInit = {
    method,
    headers: {
      ...(session?.userId && { 'x-user-id': session.userId }),
      'content-type': request.headers.get('content-type') || '',
    },
    body: method !== 'GET' && method !== 'HEAD' ? await request.text() : undefined,
  };

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
    headers: responseHeaders,
  });

  await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: upstreamResponse.status });
  return addRateLimitHeaders(response);
}
