import { NextResponse, NextRequest } from 'next/server';
import { prisma, isDbHealthy, dbErrorResponse } from '../../../lib/db/prisma';
import { getSession, isAdmin } from '@/lib/session';
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
  requestLoginOtpHandler,
  verifyLoginOtpHandler,
  requestMagicLinkHandler,
  verifyMagicLinkHandler,
  requestPasswordResetHandler,
  verifyPasswordResetHandler,
  confirmPasswordResetHandler,
  accountRecoveryHandler,
  suspiciousLoginConfirmHandler,
  suspiciousLoginDenyHandler,
  verifyHandler,
   helpConfigHandler,
   faqHandler,
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

import {
  oauthAuthorizeHandler,
  oauthTokenHandler,
  oauthRevokeHandler,
  oidcUserInfoHandler,
  oauthConsentInfoHandler,
} from '../../../lib/oauthHandlers';

import {
  extendedProfileHandler,
  changePasswordHandler,
  sessionsHandler,
  notificationsHandler,
  pushSubscriptionHandler,
  sendTestPushHandler,
  oauthUnlinkHandler,
  integrationsHandler,
  userActivityHandler,
  preferencesHandler,
  setPasswordHandler,
  requestProfileEditOtpHandler,
  verifyProfileEditOtpHandler,
  avatarUploadHandler,
  heartbeatHandler,
  notificationPrefsHandler,
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

import {
  helpArticlesListHandler,
  helpArticlesCreateHandler,
  helpArticlesUpdateHandler,
  helpArticlesDeleteHandler,
  helpArticleDetailHandler,
} from '../../../lib/helpHandlers';

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

import {
  oauthAdminAppsListHandler,
  oauthAdminAppsCreateHandler,
  oauthAdminAppsUpdateHandler,
  oauthAdminAppsDeleteHandler,
  oauthAdminClientsCreateHandler,
  oauthAdminClientsUpdateHandler,
  oauthAdminClientsRegenerateSecretHandler,
  oauthAdminClientsDeleteHandler,
} from '../../../lib/oauthAdminHandlers';

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
  settingsListHandler, settingsUpdateHandler,
  featureFlagsListHandler, featureFlagsUpdateHandler,
  appsListHandler, appsAdminListHandler, appsCreateHandler,
  incidentsListHandler, incidentsCreateHandler,
  jobsListHandler,
} from '../../../lib/contentHandlers';

import {
  ticketListHandler, ticketCreateHandler, ticketDetailHandler, ticketUpdateHandler,
  ticketMessageHandler, ticketAssignHandler, ticketCloseHandler, ticketReopenHandler,
  ticketAppealsHandler, ticketAppealUnblockHandler,
  ticketAttachmentsListHandler, ticketAttachmentsUploadHandler,
  queuesListHandler, queuesCreateHandler,
} from '../../../lib/supportHandlers';

import {
  listForms, createForm, getForm, updateForm, deleteForm, importForm,
  listMyResponses,
  publishForm, archiveForm,
  getPublicForm, submitResponse,
  listResponses, getResponse, deleteResponse, updateResponse,
  getFormAnalytics,
  listCollaborators, addCollaborator, removeCollaborator,
  listVersions, restoreVersion,
  getFormSettings, updateFormSettings, testFormWebhook,
  publicDirectory, exportResponses,
  listTemplates, createTemplate, deleteTemplate, useTemplate,
  getFormOverview,
} from '../../../lib/formHandlers';

import {
  loginHistoryHandler,
} from '../../../lib/securityHandlers';

import {
  incidentEventsListHandler, incidentEventsCreateHandler,
} from '../../../lib/contentHandlers';

import {
  formPagesListHandler, formPagesCreateHandler,
  responseAnswersListHandler,
  responseNotesListHandler, responseNotesCreateHandler,
  getFormSettingsHandler, updateFormSettingsHandler,
} from '../../../lib/formHandlers';

import {
  publicHealthHandler, detailedHealthHandler, poolHealthHandler,
} from '../../../lib/health';
import {
  cacheDebugHandler, cacheResetDebugHandler,
} from '../../../lib/debugHandlers';

import { createJob, retryJob } from '../../../lib/jobs';

const appUrl = (subdomain: string, path: string) =>
  `https://${subdomain}.${process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app'}${path}`;

const INTERNAL_ROUTES = [
  'auth/login', 'auth/signup', 'auth/email-exists', 'auth/username-exists', 'auth/logout',
  'auth/email-otp/request', 'auth/email-otp/verify',
  'auth/phone-otp/request', 'auth/phone-otp/verify',
    'auth/signup-otp/request', 'auth/signup-otp/verify',
    'auth/change-email/request', 'auth/change-email/verify',
  'auth/oauth-consent',
  'auth/login-otp/request', 'auth/login-otp/verify',
  'auth/magic-link/request', 'auth/magic-link/verify',
  'auth/google', 'auth/google/callback', 'auth/github', 'auth/github/callback',
  'auth/discord', 'auth/discord/callback',
  'auth/verify-2fa', 'auth/recovery-2fa',
  'auth/recovery-login/request', 'auth/recovery-login/verify',
  'auth/password-reset/request', 'auth/password-reset/verify', 'auth/password-reset/confirm',
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
  'profile/request-edit-otp', 'profile/verify-edit-otp', 'profile/avatar',
  'notifications', 'notifications/prefs', 'notifications/push', 'notifications/push/subscribe', 'integrations', 'user/activity', 'preferences',
  'admin/heartbeat',
  'email/config', 'email/templates', 'email/test', 'admin/emails', 'admin/emails/reply',
  'public/help-config', 'public/faq',
  'districts',
  'developer/api-keys',
  'user/mailbox', 'user/mailbox/check', 'user/mailbox/dns',
  'user/apps',
  'admin/reserved-addresses',
  'admin/oauth/apps', 'admin/oauth/clients',
  'admin/help-articles',
  'admin/groups',
  'admin/ous',
  'admin/integrations',
  'admin/security/score',
  'passkey/register/options', 'passkey/register/verify',
  'passkey/auth/options', 'passkey/auth/verify',
  'passkey/list',
  'connected-accounts', 'connected-accounts/link',
  'user/export-data', 'user/delete-account', 'profile/public',
   'auth/cli-token',
   'waitlist',
   'feedback',
   'chat',
   'admin/subscribers',
   'admin/feedback',    'health',
    'health/pool',
    'debug/cache',
    'debug/cache/reset',
    'debug/rate-limits/reset',
  // Support
  'support/tickets', 'support/tickets/create',  'support/tickets/appeals',
  'support/queues', 'support/queues/create',
  // Forms
  'forms', 'forms/create',
  'forms/import',
  'forms/public',
  'forms/directory',      'forms/my-responses',
  'form-settings',
  'templates',
  // OAuth / OIDC
  'auth/oauth/authorize', 'auth/oauth/token', 'auth/oauth/revoke', 'auth/oauth/consent',
  'oidc/userinfo',
];

let routeCache: { data: any[]; ts: number } | null = null;
let blockCache: { data: any[]; ts: number } | null = null;
const CACHE_TTL = 60000; // 60s cache for blocks — stale-while-revalidate pattern
const STALE_TTL = 300_000; // serve stale data for up to 5 min if DB is down

async function loadRoutes() {
  // Route model removed - all routes handled by INTERNAL_ROUTES and dynamic route matching
  return [];
}

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

function matchRoute(slug: string[], method: string, routes: any[]) {
  const pathPart = slug.join('/');
  // Internal/fixed routes take precedence over stale DB route rows: DB rows can
  // carry restricted allowed_roles or proxy targets that would shadow the
  // hard-coded auth handlers (e.g. a seeded 'auth/login' row → 403 for guests).
  const dbRoute = !INTERNAL_ROUTES.includes(pathPart)
    ? routes.find((r) => r.path === pathPart && r.method.toUpperCase() === method.toUpperCase())
    : undefined;
  if (dbRoute) return dbRoute;

  // Handle email/templates/{name} dynamic route
  if (slug.length === 3 && slug[0] === 'email' && slug[1] === 'templates') {
    const templateName = slug[2];
    const allowed = ['GET', 'PATCH', 'DELETE'];
    if (allowed.includes(method.toUpperCase())) {
      return { path: 'email/templates/[name]', method, internal: true, allowedRoles: ['guest'], meta: { templateName } };
    }
  }

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

  // Handle admin/oauth/apps/{id} dynamic route
  if (slug.length === 4 && slug[0] === 'admin' && slug[1] === 'oauth' && slug[2] === 'apps') {
    const oauthAppId = slug[3];
    if (method.toUpperCase() === 'PATCH' || method.toUpperCase() === 'DELETE') {
      return { path: 'admin/oauth/apps/[id]', method, internal: true, allowedRoles: ['guest'], meta: { oauthAppId } };
    }
  }

  // Handle admin/oauth/clients/{id} dynamic route
  if (slug.length === 4 && slug[0] === 'admin' && slug[1] === 'oauth' && slug[2] === 'clients') {
    const oauthClientId = slug[3];
    if (method.toUpperCase() === 'PATCH' || method.toUpperCase() === 'DELETE') {
      return { path: 'admin/oauth/clients/[id]', method, internal: true, allowedRoles: ['guest'], meta: { oauthClientId } };
    }
  }

  // Handle admin/help-articles/{id} dynamic route
  if (slug.length === 3 && slug[0] === 'admin' && slug[1] === 'help-articles') {
    const helpArticleId = slug[2];
    if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'PATCH' || method.toUpperCase() === 'DELETE') {
      return { path: 'admin/help-articles/[id]', method, internal: true, allowedRoles: ['guest'], meta: { helpArticleId } };
    }
  }

  // Handle admin/oauth/clients/{id}/secret dynamic route
  if (slug.length === 5 && slug[0] === 'admin' && slug[1] === 'oauth' && slug[2] === 'clients' && slug[4] === 'secret') {
    if (method.toUpperCase() === 'POST') {
      return { path: 'admin/oauth/clients/[id]/secret', method, internal: true, allowedRoles: ['guest'], meta: { oauthClientId: slug[3] } };
    }
  }

// connected-accounts routes removed (LinkedAccount model removed)

  // Handle templates/{id} dynamic route (use or delete)
  if (slug.length === 2 && slug[0] === 'templates') {
    const templateId = slug[1];
    if (method.toUpperCase() === 'POST') {
      return { path: 'templates/[id]/use', method, internal: true, allowedRoles: ['guest'], meta: { templateId } };
    }
    if (method.toUpperCase() === 'DELETE') {
      return { path: 'templates/[id]', method, internal: true, allowedRoles: ['guest'], meta: { templateId } };
    }
  }

  // Handle passkey/{id} dynamic route
  if (slug.length === 2 && slug[0] === 'passkey') {
    const passkeyId = slug[1];
    if (method.toUpperCase() === 'DELETE') {
      return { path: 'passkey/[id]', method: 'DELETE', internal: true, allowedRoles: ['guest'], meta: { passkeyId } };
    }
    if (method.toUpperCase() === 'PATCH') {
      return { path: 'passkey/[id]', method: 'PATCH', internal: true, allowedRoles: ['guest'], meta: { passkeyId } };
    }
  }





  // Handle content/retry-job/{id} dynamic route
  if (slug.length === 3 && slug[0] === 'content' && slug[1] === 'retry-job') {
    return { path: 'content/retry-job/[id]', method: 'POST', internal: true, allowedRoles: ['guest'], meta: { retryJobId: slug[2] } };
  }

  // Handle content/incidents/{id}/events dynamic route
  if (slug.length === 4 && slug[0] === 'content' && slug[1] === 'incidents' && slug[3] === 'events') {
    return { path: 'content/incidents/[id]/events', method, internal: true, allowedRoles: ['guest'], meta: { incidentId: slug[2] } };
  }

  // Handle support/tickets/{id} dynamic route
  if (slug.length === 3 && slug[0] === 'support' && slug[1] === 'tickets') {
    const ticketId = slug[2];
    const allowed: Record<string, string[]> = { 'GET': ['GET'], 'PATCH': ['PATCH'], 'DELETE': ['DELETE'] };
    if (allowed[method.toUpperCase()]) {
      return { path: 'support/tickets/[id]', method, internal: true, allowedRoles: ['guest'], meta: { ticketId } };
    }
  }

  // Handle support/tickets/{id}/messages, assign, close, reopen
  if (slug.length === 4 && slug[0] === 'support' && slug[1] === 'tickets') {
    const action = slug[3];
    if (['messages', 'assign', 'close', 'reopen', 'attachments'].includes(action)) {
      return { path: `support/tickets/[id]/${action}`, method, internal: true, allowedRoles: ['guest'], meta: { ticketId: slug[2] } };
    }
  }

  // Handle support/tickets/appeals/{rayId}/unblock
  if (slug.length === 5 && slug[0] === 'support' && slug[1] === 'tickets' && slug[2] === 'appeals' && slug[4] === 'unblock') {
    return { path: 'support/tickets/appeals/[rayId]/unblock', method, internal: true, allowedRoles: ['guest'], meta: { appealRayId: slug[3] } };
  }

  // Handle forms/my-responses (user's submitted responses) before the forms/{id} catch-all
  if (slug.length === 2 && slug[0] === 'forms' && slug[1] === 'my-responses') {
    if (method.toUpperCase() === 'GET') {
      return { path: 'forms/my-responses', method, internal: true, allowedRoles: ['guest'] };
    }
  }

  // Handle forms/create (create form) — must be before forms/{id} catch-all
  if (slug.length === 2 && slug[0] === 'forms' && slug[1] === 'create') {
    if (method.toUpperCase() === 'POST') {
      return { path: 'forms/create', method, internal: true, allowedRoles: ['guest'] };
    }
  }

  // Handle forms/import (import form) — must be before forms/{id} catch-all
  if (slug.length === 2 && slug[0] === 'forms' && slug[1] === 'import') {
    if (method.toUpperCase() === 'POST') {
      return { path: 'forms/import', method, internal: true, allowedRoles: ['guest'] };
    }
  }

  // Handle forms/public (public directory listing) — must be before forms/{id} catch-all
  if (slug.length === 2 && slug[0] === 'forms' && slug[1] === 'public') {
    if (method.toUpperCase() === 'GET') {
      return { path: 'forms/public', method, internal: true, allowedRoles: ['guest'] };
    }
  }

  // Handle forms/directory (public directory listing alias)
  if (slug.length === 2 && slug[0] === 'forms' && slug[1] === 'directory') {
    if (method.toUpperCase() === 'GET') {
      return { path: 'forms/directory', method, internal: true, allowedRoles: ['guest'] };
    }
  }

  // Handle forms/{id} dynamic route
  if (slug.length === 2 && slug[0] === 'forms') {
    const formId = slug[1];
    const allowed: Record<string, string[]> = { 'GET': ['GET'], 'PATCH': ['PATCH', 'PUT'], 'DELETE': ['DELETE'] };
    if (allowed[method.toUpperCase()]) {
      return { path: 'forms/[id]', method, internal: true, allowedRoles: ['guest'], meta: { formId } };
    }
  }

  // Handle forms/{id}/* sub-routes
  if (slug.length >= 3 && slug[0] === 'forms') {
    const formId = slug[1];
    const action = slug[2];
    if (['publish', 'archive', 'responses', 'analytics', 'collaborators', 'versions', 'settings', 'export', 'pages', 'overview'].includes(action)) {
      return { path: `forms/[id]/${action}`, method, internal: true, allowedRoles: ['guest'], meta: { formId } };
    }
    // Handle forms/{id}/webhook/test
    if (action === 'webhook' && slug.length === 4 && slug[3] === 'test') {
      return { path: 'forms/[id]/webhook/test', method, internal: true, allowedRoles: ['guest'], meta: { formId } };
    }
    // Handle forms/{id}/pages dynamic route
    if (action === 'pages' && slug.length >= 4) {
      return { path: 'forms/[id]/pages/[pageId]', method, internal: true, allowedRoles: ['guest'], meta: { formId, pageId: slug[3] } };
    }
  }

  // Handle forms/{id}/responses/{responseId}
  if (slug.length === 4 && slug[0] === 'forms' && slug[2] === 'responses') {
    return { path: 'forms/[id]/responses/[responseId]', method, internal: true, allowedRoles: ['guest'], meta: { formId: slug[1], responseId: slug[3] } };
  }

  // Handle forms/{id}/responses/{responseId}/answers
  if (slug.length === 5 && slug[0] === 'forms' && slug[2] === 'responses' && slug[4] === 'answers') {
    return { path: 'forms/[id]/responses/[responseId]/answers', method, internal: true, allowedRoles: ['guest'], meta: { formId: slug[1], responseId: slug[3] } };
  }

  // Handle forms/{id}/responses/{responseId}/notes
  if (slug.length === 5 && slug[0] === 'forms' && slug[2] === 'responses' && slug[4] === 'notes') {
    return { path: 'forms/[id]/responses/[responseId]/notes', method, internal: true, allowedRoles: ['guest'], meta: { formId: slug[1], responseId: slug[3] } };
  }

  // Handle forms/{id}/collaborators/{collaboratorId}
  if (slug.length === 4 && slug[0] === 'forms' && slug[2] === 'collaborators') {
    return { path: 'forms/[id]/collaborators/[collaboratorId]', method, internal: true, allowedRoles: ['guest'], meta: { formId: slug[1], collaboratorId: slug[3] } };
  }

  // Handle forms/{id}/versions/{versionId}/restore
  if (slug.length === 5 && slug[0] === 'forms' && slug[2] === 'versions' && slug[4] === 'restore') {
    return { path: 'forms/[id]/versions/[versionId]/restore', method, internal: true, allowedRoles: ['guest'], meta: { formId: slug[1], versionId: slug[3] } };
  }

  // Handle public forms: forms/public/{publicId}
  if (slug.length === 3 && slug[0] === 'forms' && slug[1] === 'public') {
    return { path: 'forms/public/[publicId]', method, internal: true, allowedRoles: ['guest'], meta: { publicId: slug[2] } };
  }

  // Handle public form submission: forms/public/{publicId}/submit
  if (slug.length === 4 && slug[0] === 'forms' && slug[1] === 'public' && slug[3] === 'submit') {
    return { path: 'forms/public/[publicId]/submit', method, internal: true, allowedRoles: ['guest'], meta: { publicId: slug[2] } };
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
      'auth/login-otp/request': ['POST'],
      'auth/login-otp/verify': ['POST'],
      'auth/magic-link/request': ['POST'],
      'auth/magic-link/verify': ['POST'],
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
      'profile': ['GET', 'PATCH'],
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
      'notifications/push': ['POST'],
      'notifications/push/subscribe': ['GET', 'POST', 'DELETE'],
      'integrations': ['GET', 'POST', 'DELETE'],
      'user/activity': ['GET'],
      'preferences': ['GET', 'PATCH'],
      'admin/heartbeat': ['POST'],
      'email/config': ['GET', 'PATCH'],
      'email/templates': ['GET', 'POST'],
      'email/test': ['POST'],
      'admin/emails': ['GET'],
      'admin/emails/reply': ['POST'],
      'public/help-config': ['GET'],
      'public/faq': ['GET'],
      'districts': ['GET'],
      'developer/api-keys': ['GET', 'POST'],
      'user/mailbox': ['GET', 'POST', 'PUT', 'DELETE'],
      'user/mailbox/check': ['GET'],
      'user/mailbox/dns': ['GET'],
      'user/apps': ['GET', 'POST', 'PUT', 'DELETE'],
      'admin/reserved-addresses': ['GET', 'POST'],
      'admin/oauth/apps': ['GET', 'POST'],
      'admin/oauth/clients': ['POST'],
      'admin/help-articles': ['GET', 'POST'],
      'admin/groups': ['GET', 'POST'],
      'admin/ous': ['GET', 'POST'],
      'admin/integrations': ['GET', 'POST', 'DELETE'],
      'admin/security/score': ['GET'],
      'passkey/register/options': ['POST'],
      'passkey/register/verify': ['POST'],
      'passkey/auth/options': ['POST'],
      'passkey/auth/verify': ['POST'],
      'passkey/list': ['GET'],
      'connected-accounts': ['GET', 'DELETE'],
      'connected-accounts/link': ['POST'],
      'user/export-data': ['GET', 'POST'],
      'user/delete-account': ['POST'],
      'profile/public': ['GET'],
      'auth/cli-token': ['POST'],
      'waitlist': ['POST'],
      'feedback': ['POST', 'GET'],
      'chat': ['POST'],
      'admin/subscribers': ['GET'],
      'admin/feedback': ['GET'],
      'health': ['GET'],
      'health/pool': ['GET'],
      'debug/cache': ['GET'],
      'debug/cache/reset': ['POST'],
      'debug/rate-limits/reset': ['GET'],
      // Content
      'content/settings': ['GET'],
      'content/settings/update': ['PATCH'],
      'content/feature-flags': ['GET'],
      'content/feature-flags/update': ['PATCH'],
      'content/apps': ['GET'],
      'content/apps/admin': ['GET'],
      'content/apps/create': ['POST'],
      'content/health': ['GET'],
      'content/incidents': ['GET'],
      'content/incidents/create': ['POST'],
      'content/incidents/[id]/events': ['GET', 'POST'],
      'content/jobs': ['GET'],
      'content/jobs/create': ['POST'],
      'content/retry-job': ['POST'],
      // Support
      'support/tickets': ['GET'],
      'support/tickets/create': ['POST'],
      'support/tickets/[id]/attachments': ['GET', 'POST'],
      'support/tickets/appeals': ['GET'],
      'support/queues': ['GET'],
      'support/queues/create': ['POST'],
      // Forms
      'forms': ['GET', 'POST'],
      'forms/create': ['POST'],
      'forms/import': ['POST'],
      'forms/[id]/pages': ['GET', 'POST'],
      'forms/[id]/pages/[pageId]': ['GET', 'PATCH', 'DELETE'],
      'forms/[id]/responses/[responseId]/answers': ['GET'],
      'forms/[id]/responses/[responseId]/notes': ['GET', 'POST'],
      'forms/public': ['GET'],
      'forms/directory': ['GET'],
      'form-settings': ['GET', 'PATCH'],
      'templates': ['GET', 'POST'],
      // OAuth / OIDC
      'auth/oauth/authorize': ['POST'],
      'auth/oauth/token': ['POST'],
      'auth/oauth/revoke': ['POST'],
      'auth/oauth/consent': ['GET'],
      'oidc/userinfo': ['GET'],
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
    [routes, blocked] = await Promise.all([loadRoutes(), loadBlocked()]);
  } catch (e: any) {
    console.error('[HANDLER] loadRoutes/loadBlocked failed:', e?.message);
    return NextResponse.json({ error: 'Database connection error' }, { status: 500 });
  }

  if (isBlocked(ip, session?.userId, blocked)) {
    console.warn(`[AUTH] Blocked request — ip: ${ip}, user: ${session?.userId}, path: ${pathStr}`);
    await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: 403 });
    return jsonForbidden('Your IP or account has been blocked');
  }

  const route = matchRoute(slug, method, routes);
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
  const SKIP_DB_CHECK = ['health', 'health/pool', 'captcha/status', 'captcha/challenge',
    'public/app-config', 'public/help-config', 'public/faq', 'public/theme', 'public/branding',
    'public/landing', 'public/landing-config', 'admin/check-setup'];
  if (!SKIP_DB_CHECK.includes(pathStr) && !pathStr.startsWith('forms/public/')) {
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
      case 'captcha/challenge':
        resp = await captchaChallengeHandler(request);
        break;
      case 'captcha/verify':
        resp = await captchaVerifyHandler(request);
        break;
      case 'captcha/status':
        resp = await captchaStatusHandler(request);
        break;
      case 'captcha/image/[id]':
        resp = await captchaImageHandler(request, (route as any).meta.imageId);
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
        resp = await oauthConsentHandler(request);
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
      case 'auth/magic-link/verify':
        resp = await verifyMagicLinkHandler(request);
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
      case 'profile/oauth/[provider]':
        resp = await oauthUnlinkHandler(request, (route as any).meta.provider);
        break;
      case 'notifications':
        resp = await notificationsHandler(request);
        break;
      case 'notifications/prefs':
        resp = await notificationPrefsHandler(request);
        break;
      case 'notifications/push':
        resp = await sendTestPushHandler(request);
        break;
      case 'notifications/push/subscribe':
        resp = await pushSubscriptionHandler(request);
        break;
      case 'integrations':
        resp = await integrationsHandler(request);
        break;
      case 'user/activity':
        resp = await userActivityHandler(request);
        break;
      case 'preferences':
        resp = await preferencesHandler(request);
        break;
      case 'admin/heartbeat':
        resp = await heartbeatHandler(request);
        break;
      case 'email/config':
        resp = await emailConfigHandler(request);
        break;
      case 'email/templates':
        resp = await emailTemplatesHandler(request);
        break;
      case 'email/test':
        resp = await emailTestHandler(request);
        break;
      case 'admin/emails':
        resp = await adminEmailsHandler(request);
        break;
      case 'admin/emails/reply':
        resp = await adminEmailReplyHandler(request);
        break;
      case 'public/help-config':
        resp = await helpConfigHandler(request);
        break;
      case 'public/faq':
        resp = await faqHandler(request);
        break;
      case 'districts':

        break;
      case 'developer/api-keys':
        resp = await apiKeysHandler(request);
        break;
      case 'developer/api-keys/[id]':
        resp = await apiKeyDeleteHandler(request, (route as any).meta.keyId);
        break;

      case 'admin/oauth/apps':
        if (method === 'GET') resp = await oauthAdminAppsListHandler(request);
        else resp = await oauthAdminAppsCreateHandler(request);
        break;
      case 'admin/oauth/apps/[id]':
        if (method === 'PATCH') resp = await oauthAdminAppsUpdateHandler(request, (route as any).meta.oauthAppId);
        else if (method === 'DELETE') resp = await oauthAdminAppsDeleteHandler(request, (route as any).meta.oauthAppId);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'admin/oauth/clients':
        resp = await oauthAdminClientsCreateHandler(request);
        break;
      case 'admin/oauth/clients/[id]':
        if (method === 'PATCH') resp = await oauthAdminClientsUpdateHandler(request, (route as any).meta.oauthClientId);
        else if (method === 'DELETE') resp = await oauthAdminClientsDeleteHandler(request, (route as any).meta.oauthClientId);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'admin/oauth/clients/[id]/secret':
        resp = await oauthAdminClientsRegenerateSecretHandler(request, (route as any).meta.oauthClientId);
        break;

      case 'admin/help-articles':
        if (method === 'GET') resp = await helpArticlesListHandler(request);
        else resp = await helpArticlesCreateHandler(request);
        break;
      case 'admin/help-articles/[id]':
        if (method === 'GET') resp = await helpArticleDetailHandler(request, (route as any).meta.helpArticleId);
        else if (method === 'PATCH') resp = await helpArticlesUpdateHandler(request, (route as any).meta.helpArticleId);
        else if (method === 'DELETE') resp = await helpArticlesDeleteHandler(request, (route as any).meta.helpArticleId);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;

      case 'admin/groups':
        resp = new NextResponse('Handled by standalone route', { status: 200 });
        break;

      case 'admin/integrations':
        resp = new NextResponse('Handled by standalone route', { status: 200 });
        break;
      case 'admin/security/score':
        resp = new NextResponse('Handled by standalone route', { status: 200 });
        break;

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
        else resp = new NextResponse('Method not allowed', { status: 405 });
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

      case 'auth/oauth/authorize':
        resp = await oauthAuthorizeHandler(request);
        break;
      case 'auth/oauth/consent':
        resp = await oauthConsentInfoHandler(request);
        break;
      case 'auth/oauth/token':
        resp = await oauthTokenHandler(request);
        break;
      case 'auth/oauth/revoke':
        resp = await oauthRevokeHandler(request);
        break;
      case 'oidc/userinfo':
        resp = await oidcUserInfoHandler(request);
        break;
      case 'email/templates/[name]':
        resp = await emailTemplateDetailHandler(request, (route as any).meta.templateName);
        break;
      case 'admin/emails/[id]':
        resp = await adminEmailDetailHandler(request, (route as any).meta.emailId);
        break;
      // Content routes
      case 'content/settings':
        resp = await settingsListHandler(request);
        break;
      case 'content/settings/update':
        resp = await settingsUpdateHandler(request);
        break;
      case 'content/feature-flags':
        resp = await featureFlagsListHandler(request);
        break;
      case 'content/feature-flags/update':
        resp = await featureFlagsUpdateHandler(request);
        break;
      case 'content/apps':
        resp = await appsListHandler(request);
        break;
      case 'content/apps/admin':
        resp = await appsAdminListHandler(request);
        break;
      case 'content/apps/create':
        resp = await appsCreateHandler(request);
        break;
      case 'content/health':

        break;
      case 'content/incidents':
        resp = await incidentsListHandler(request);
        break;
      case 'content/incidents/create':
        resp = await incidentsCreateHandler(request);
        break;
      case 'content/incidents/[id]/events':
        if (method === 'GET') resp = await incidentEventsListHandler(request, (route as any).meta.incidentId);
        else if (method === 'POST') resp = await incidentEventsCreateHandler(request, (route as any).meta.incidentId);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'content/jobs':
        resp = await jobsListHandler(request);
        break;
      // Support routes
      case 'support/tickets':
        resp = await ticketListHandler(request);
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
        else if (method === 'PATCH') resp = await ticketUpdateHandler(request, (route as any).meta.ticketId);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'support/tickets/[id]/messages':
        resp = await ticketMessageHandler(request, (route as any).meta.ticketId);
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
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'support/queues':
        resp = await queuesListHandler(request);
        break;
      case 'support/queues/create':
        resp = await queuesCreateHandler(request);
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
      case 'debug/rate-limits/reset': {
        const { clearRateLimits } = await import('../../../lib/captcha/risk');
        clearRateLimits();
        resp = NextResponse.json({ success: true, message: 'Rate limits cleared' });
        break;
      }
      case 'content/health':
        resp = await detailedHealthHandler(request);
        break;
      case 'content/jobs/create': {
        const jobAdmin = await isAdmin(request);
        if (!jobAdmin) {
          await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: 403 });
          resp = jsonForbidden();
          break;
        }
        const jobBody: any = await request.json();
        const job = await createJob(jobBody.type, jobBody.payload || {}, jobBody.queue || 'default', jobBody.maxAttempts || 3);
        resp = NextResponse.json(job, { status: 201 });
        break;
      }
      case 'content/retry-job/[id]': {
        const retryAdmin = await isAdmin(request);
        if (!retryAdmin) {
          await logRequest({ ip, method, path: pathStr, userId: session?.userId, status: 403 });
          resp = jsonForbidden();
          break;
        }
        await retryJob((route as any).meta.retryJobId);
        resp = NextResponse.json({ message: 'Job queued for retry' });
        break;
      }
      // Form routes
      case 'forms':
        if (method === 'POST') resp = await createForm(request);
        else resp = await listForms(request);
        break;
      case 'forms/my-responses':
        resp = await listMyResponses(request);
        break;
      case 'forms/create':
        resp = await createForm(request);
        break;
      case 'forms/import':
        resp = await importForm(request);
        break;
      case 'forms/[id]':
        if (method === 'GET') resp = await getForm(request, (route as any).meta.formId);
        else if (method === 'PATCH' || method === 'PUT') resp = await updateForm(request, (route as any).meta.formId);
        else if (method === 'DELETE') resp = await deleteForm(request, (route as any).meta.formId);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'forms/[id]/publish':
        resp = await publishForm(request, (route as any).meta.formId);
        break;
      case 'forms/[id]/archive':
        resp = await archiveForm(request, (route as any).meta.formId);
        break;
      case 'forms/[id]/responses':
        resp = await listResponses(request, (route as any).meta.formId);
        break;
      case 'forms/[id]/overview':
        resp = await getFormOverview(request, (route as any).meta.formId);
        break;
      case 'forms/[id]/analytics':
        resp = await getFormAnalytics(request, (route as any).meta.formId);
        break;
      case 'forms/[id]/pages':
        if (method === 'GET') resp = await formPagesListHandler(request, (route as any).meta.formId);
        else if (method === 'POST') resp = await formPagesCreateHandler(request, (route as any).meta.formId);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'forms/[id]/settings':
        if (method === 'GET') resp = await getFormSettings(request, (route as any).meta.formId);
        else if (method === 'PATCH' || method === 'PUT') resp = await updateFormSettings(request, (route as any).meta.formId);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'forms/[id]/export':
        resp = await exportResponses(request, (route as any).meta.formId);
        break;
      case 'forms/[id]/webhook/test':
        if (method === 'POST') resp = await testFormWebhook(request, (route as any).meta.formId);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'forms/[id]/collaborators':
        if (method === 'GET') resp = await listCollaborators(request, (route as any).meta.formId);
        else if (method === 'POST') resp = await addCollaborator(request, (route as any).meta.formId);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'forms/[id]/collaborators/[collaboratorId]':
        resp = await removeCollaborator(request, (route as any).meta.formId, (route as any).meta.collaboratorId);
        break;
      case 'forms/[id]/versions':
        resp = await listVersions(request, (route as any).meta.formId);
        break;
      case 'forms/[id]/versions/[versionId]/restore':
        resp = await restoreVersion(request, (route as any).meta.formId, (route as any).meta.versionId);
        break;
case 'forms/[id]/responses/[responseId]':
         if (method === 'GET') resp = await getResponse(request, (route as any).meta.formId, (route as any).meta.responseId);
         else if (method === 'PATCH' || method === 'PUT') resp = await updateResponse(request, (route as any).meta.formId, (route as any).meta.responseId);
         else if (method === 'DELETE') resp = await deleteResponse(request, (route as any).meta.formId, (route as any).meta.responseId);
         else resp = new NextResponse('Method not allowed', { status: 405 });
         break;
      case 'forms/[id]/responses/[responseId]/answers':
         if (method === 'GET') resp = await responseAnswersListHandler(request, (route as any).meta.responseId);
         else resp = new NextResponse('Method not allowed', { status: 405 });
         break;
      case 'forms/[id]/responses/[responseId]/notes':
         if (method === 'GET') resp = await responseNotesListHandler(request, (route as any).meta.responseId);
         else if (method === 'POST') resp = await responseNotesCreateHandler(request, (route as any).meta.responseId);
         else resp = new NextResponse('Method not allowed', { status: 405 });
         break;
      case 'forms/public':
        resp = await publicDirectory(request);
        break;
      case 'forms/directory':
        resp = await publicDirectory(request);
        break;
      case 'form-settings':
        if (method === 'GET') resp = await getFormSettingsHandler(request);
        else if (method === 'PATCH') resp = await updateFormSettingsHandler(request);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'templates':
        if (method === 'GET') resp = await listTemplates(request);
        else if (method === 'POST') resp = await createTemplate(request);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'templates/[id]/use':
        resp = await useTemplate(request, (route as any).meta.templateId);
        break;
      case 'templates/[id]':
        if (method === 'DELETE') resp = await deleteTemplate(request, (route as any).meta.templateId);
        else resp = new NextResponse('Method not allowed', { status: 405 });
        break;
      case 'forms/public/[publicId]':
        resp = await getPublicForm(request, (route as any).meta.publicId);
        break;
      case 'forms/public/[publicId]/submit':
        resp = await submitResponse(request, (route as any).meta.publicId);
        break;
      default:
        resp = new NextResponse('Internal route not implemented', { status: 501 });
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
        include: { roles: { include: { role: true } } },
      });
      const firstRole = user?.roles?.[0]?.role;
      userRole = firstRole?.name?.toLowerCase() || 'member';
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
