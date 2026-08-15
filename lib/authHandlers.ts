import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from './db/prisma';
import { generateOtpCode, storeOtp, verifyOtpCode, sendEmailOtp, sendPhoneOtp } from './auth/otp';
import { generateOtpCode as genSignupOtp, storeSignupOtp, verifySignupOtp, sendSignupOtpEmail, checkSignupOtp } from './auth/signup-otp';
import { hashPassword, verifyPassword, hashOtpCode, hashRecoveryCode } from './auth/password';
import { createSession, setSessionCookie, clearSessionCookie, revokeSession, rotateRefreshToken, REFRESH_COOKIE_NAME, COOKIE_DOMAIN } from './auth/session';
import { getSession, requireAdmin } from './session';
import { signTemp2faToken, verifyTemp2faToken, signMagicLinkToken, verifyMagicLinkToken, signOauthStateToken, verifyOauthStateToken, verifySuspiciousLoginToken, verifySessionRevokeToken, signTempPasswordChangeToken } from './auth/jwt';

import { verifyTotp } from './auth/totp';
import { sendTemplateEmail } from './email';
import { sanitizeInput, logSecurityEvent } from './security';
import { requestPasswordReset, requestPasswordResetOtp, requestPasswordResetMagicLink, requestPasswordResetRecovery, verifyPasswordReset, confirmPasswordReset } from './auth/password-reset';
import { createAuditEvent } from './audit';
import { enforceResendCooldown } from './auth/resend-cooldown';
import { checkPasswordBreach } from './auth/breach';
import { jsonUnauthorized } from './response';
import { createNotification } from './notifications';
import { createTtlCache } from './cache';
import { logPerformance } from './perf';
import { SignJWT } from 'jose';
import { checkWindowLimit, computeRiskScore, recordDeviceSeen } from './captcha/risk';
import { getUserWarningCount, getRequiredDifficulty, assertCaptchaSatisfied, hasRecentLoginSuccess, getCaptchaSettings } from './captcha/service';
import { recordRateLimitHit, clearRateLimitHits } from './auth/suspicious-activity';
import { getAccountsBaseUrl } from './app-urls';

// Cache email existence lookups (login/signup fire these on every debounced
// keystroke). Results are almost never changed mid-session, so a 30s TTL is
// safe and removes a DB round-trip per keystroke.
const emailExistsCache = createTtlCache<{ exists: boolean; hasPassword: boolean; photoUrl: string | null; name: string | null; hasRecoveryEmail: boolean; recoveryEmail: string | null }>(30_000, 5000, 'emailExists');

// Cache for GET /api/users/me — dashboard polls this frequently.
// 10s TTL: stale data is acceptable for profile display, and bust on PATCH.
const profileCache = createTtlCache<any>(10_000, 2000, 'profile');
function bustProfileCache(userId: string) { profileCache.delete(userId); }

export async function sessionHandler(request: NextRequest) {
  const startTime = performance.now();
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    
    // Check cache first — dashboard polls this frequently
    const cached = profileCache.get(session.userId);
    if (cached) {
      logPerformance('auth/session/cache', startTime);
      return NextResponse.json({ user: cached });
    }
    
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, name: true, photoUrl: true, is2FAEnabled: true, adminRole: true, roles: { include: { role: true } }, emailVerified: true, preferences: true },
    });
    if (!user) return jsonUnauthorized();
    const adminRole = user.adminRole || user.roles?.[0]?.role?.name;
    const userData = { id: user.id, email: user.email, name: user.name, photoUrl: user.photoUrl, is2FAEnabled: user.is2FAEnabled, adminRole, emailVerified: user.emailVerified, preferences: user.preferences };
    profileCache.set(session.userId, userData);
    logPerformance('auth/session', startTime);
    return NextResponse.json({ user: userData });
  } catch (err: any) {
    console.error('[SESSION]', err?.message || err);
    return new NextResponse('Failed to fetch session', { status: 500 });
  }
}

export async function refreshHandler(request: NextRequest) {
  const startTime = performance.now();
  const ip = getIp(request);
  const userAgent = request.headers.get('user-agent') || undefined;
  
  try {
    const refreshToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value;
    if (!refreshToken) {
      console.log('[REFRESH] No refresh token in cookie');
      const res = new NextResponse('Refresh token missing', { status: 401 });
      clearSessionCookie(res, request);
      return res;
    }

    // Attempt token rotation with retry for transient failures
    let result = null;
    let lastError: any = null;
    
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        result = await rotateRefreshToken(refreshToken, ip, userAgent);
        if (result) break; // Success
      } catch (err: any) {
        lastError = err;
        console.error(`[REFRESH] Attempt ${attempt} failed:`, err?.message);
        // Only retry on transient errors (network, timeout)
        if (attempt < 2 && isTransientError(err)) {
          await new Promise(r => setTimeout(r, 100 * attempt));
          continue;
        }
        break;
      }
    }

    if (!result) {
      console.log('[REFRESH] Token rotation failed, clearing session');
      const res = new NextResponse(
        lastError?.message || 'Session expired', 
        { status: 401 }
      );
      clearSessionCookie(res, request);
      return res;
    }

    // Create response with new tokens
    const res = NextResponse.json({ 
      token: result.token, 
      sessionId: result.sessionId 
    });
    
    // Always set cookies, even if there was a previous error
    setSessionCookie(res, result.token, result.refreshToken, request);
    
    logPerformance('auth/refresh', startTime);
    return res;
    
  } catch (err: any) {
    console.error('[REFRESH] Unhandled error:', err?.message || err);
    const res = new NextResponse('Refresh failed', { status: 500 });
    // On error, try to preserve existing cookies if possible
    // Only clear if we're sure the session is invalid
    if (!isTransientError(err)) {
      clearSessionCookie(res, request);
    }
    return res;
  }
}

/** Check if an error is transient (worth retrying) */
function isTransientError(err: any): boolean {
  if (!err) return false;
  const msg = err.message?.toLowerCase() || '';
  // Network errors, timeouts, rate limits are transient
  return msg.includes('timeout') || 
         msg.includes('network') || 
         msg.includes('econnreset') ||
         msg.includes('rate limit') ||
         msg.includes('too many');
}

function getIp(request: NextRequest): string | null {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip') || null;
}


function isAllowedRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (host.endsWith('.tirbeo.app')) return true;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (host.endsWith('.vercel.app') && host.startsWith('tirbeo')) return true;
    return false;
  } catch { return false; }
}

function getDynamicRedirectUri(request: NextRequest, path: string): string {
  const provider = path.split('/')[2];
  const envMap: Record<string, string | undefined> = {
    google: process.env.GOOGLE_REDIRECT_URI,
    github: process.env.GITHUB_REDIRECT_URI,
    discord: process.env.DISCORD_REDIRECT_URI,
  };
  const envUri = envMap[provider || ''];
  if (envUri) return envUri;
  const host = request.headers.get('host') || 'api.tirbeo.app';
  const protocol = request.headers.get('x-forwarded-proto') || 'https';
  // The catch-all route is at /api/[[...slug]], so the OAuth callback is /api/auth/{provider}/callback
  return `${protocol}://${host}/api${path}`;
}

interface OauthProviderConfig {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

const OAUTH_ENV_KEYS: Record<string, { id: string; secret: string; uri: string }> = {
  google: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET', uri: 'GOOGLE_REDIRECT_URI' },
  github: { id: 'GITHUB_CLIENT_ID', secret: 'GITHUB_CLIENT_SECRET', uri: 'GITHUB_REDIRECT_URI' },
  discord: { id: 'DISCORD_CLIENT_ID', secret: 'DISCORD_CLIENT_SECRET', uri: 'DISCORD_REDIRECT_URI' },
};

// The site_configs row is read on every OAuth start/callback request (~300ms DB
// round-trip). Cache it briefly — it only changes through the admin panel.
const OAUTH_CONFIG_TTL = 30_000;
let oauthConfigCache: { record: any; at: number } | null = null;

async function getOauthProviderConfig(provider: string): Promise<OauthProviderConfig> {
  const keys = OAUTH_ENV_KEYS[provider];
  let configured: any = {};
  try {
    if (!oauthConfigCache || Date.now() - oauthConfigCache.at > OAUTH_CONFIG_TTL) {
      oauthConfigCache = {
        record: await prisma.siteConfig.findUnique({ where: { app: 'accounts' } }),
        at: Date.now(),
      };
    }
    const cfgJson: any = oauthConfigCache.record?.config || {};
    configured = cfgJson?.oauth?.[provider] || {};
  } catch {
    oauthConfigCache = null;
  }
  const envConfigured = !!process.env[keys?.id];
  return {
    enabled: configured.enabled !== undefined ? !!configured.enabled : envConfigured,
    clientId: configured.clientId || process.env[keys?.id],
    clientSecret: configured.clientSecret || process.env[keys?.secret],
    redirectUri: configured.redirectUri || process.env[keys?.uri],
  };
}

function getOauthCookieDomain(request: NextRequest): string | undefined {
  const host = request.headers.get('host') || '';
  if (host.endsWith('.vercel.app')) return host;
  if (process.env.NODE_ENV !== 'development') return COOKIE_DOMAIN;
  return undefined;
}

const OAUTH_STATE_COOKIE = '__oauth_state';

// A freshly-created OAuth account has no password and no recorded consent —
// route it to the accounts app so the user can accept policy + optionally set
// a password, instead of landing straight on the dashboard.
function oauthPostLoginTarget(user: any, redirectTo: string | undefined, provider: string): string {
  const prefs: any = user?.preferences || {};
  const isNewOAuthUser = !user?.passwordHash && !prefs.signupConsent?.policyAccepted;
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
  const accountsBase = (process.env.ACCOUNTS_URL || `https://accounts.${appDomain}`).replace(/\/$/, '');
  if (isNewOAuthUser) {
    const url = new URL(`${accountsBase}/callback`);
    url.searchParams.set('oauth', 'new');
    url.searchParams.set('provider', provider);
    if (redirectTo) url.searchParams.set('redirect_to', redirectTo);
    return url.toString();
  }
  return redirectTo || `https://dashboard.${appDomain}`;
}

function setOauthStateCookie(res: NextResponse, nonce: string, request: NextRequest) {
  res.cookies.set(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
    domain: getOauthCookieDomain(request),
  });
}

function clearOauthStateCookie(res: NextResponse, request: NextRequest) {
  res.cookies.set(OAUTH_STATE_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    domain: getOauthCookieDomain(request),
  });
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  turnstileToken: z.string().optional(),
  captchaRayId: z.string().optional(),
  emailVerified: z.boolean().optional(),
  fingerprint: z.string().optional(),
});

export async function loginHandler(request: NextRequest) {
  const loginStartTime = performance.now();
  try {
    const parsed = loginSchema.safeParse(await request.json());
    if (!parsed.success) {
      return new NextResponse('Invalid email or password', { status: 400 });
    }
    const { email, password, captchaRayId, fingerprint: bodyFingerprint } = parsed.data;

    const fingerprint = bodyFingerprint
      || request.cookies.get('__dfp')?.value
      || request.headers.get('x-device-fingerprint')
      || '';

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || '';
    const captchaSession = request.cookies.get('__captcha_session')?.value || 'anonymous';
    const sessionId = captchaSession;

    if (!checkWindowLimit(`login:email:${email.toLowerCase()}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many sign-in attempts. Please try again later.', { status: 429 });
    }
    if (!checkWindowLimit(`login:ip:${ip}`, 20, 15 * 60 * 1000)) {
      return new NextResponse('Too many sign-in attempts. Please try again later.', { status: 429 });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true, email: true, passwordHash: true, is2FAEnabled: true, isBanned: true, isSuspended: true, adminRole: true, roles: { include: { role: true } } } });
    if (!user) {
      logSecurityEvent({ request, eventType: 'auth.login_failed', details: { reason: 'no_such_user' } }).catch(() => {});
      return new NextResponse('Invalid email or password', { status: 401 });
    }
    if (user.isBanned) {
      return new NextResponse('Account suspended', { status: 403 });
    }
    if (user.isSuspended) {
      return new NextResponse('Account suspended', { status: 403 });
    }
    if (!user.passwordHash) {
      return new NextResponse('Invalid email or password', { status: 401 });
    }

    // Progressive friction: if this account/IP has prior failed-attempt history,
    // require a CAPTCHA before revealing password validity — so automated
    // password-spraying is challenged before the lockout threshold is reached.
    // A recent successful login from this IP clears the friction (risk resets
    // when traffic normalizes).

    // Parallelize DB queries for speed
    const [warnings, provenIdentity, passwordValid] = await Promise.all([
      getUserWarningCount(user.id, ip),
      hasRecentLoginSuccess(ip),
      verifyPassword(user.passwordHash, password),
    ]);
    
    const forceCaptcha = !provenIdentity && (warnings.recentBlocks > 0 || warnings.count >= 2);
    if (forceCaptcha) {
      const requiredDifficulty = await getRequiredDifficulty(user.id, sessionId, ip, null);
      const check = await assertCaptchaSatisfied({
        rayId: captchaRayId,
        sessionId,
        ipAddress: ip,
        userAgent,
        fingerprint,
        requiredDifficulty,
      });
      if (!check.ok) {
        return new NextResponse(check.error, { status: 403 });
      }
    }

    if (!passwordValid) {
      recordRateLimitHit(ip);
      logSecurityEvent({ request, userId: user.id, eventType: 'auth.login_failed', details: { reason: 'wrong_password' } }).catch(() => {});
      // Record failed login attempt
      prisma.login_history.create({
        data: {
          userId: user.id,
          email: user.email,
          ipAddress: ip,
          userAgent: userAgent || null,
          success: false,
          method: 'password',
        },
      }).catch(() => {});
      return new NextResponse('Invalid email or password', { status: 401 });
    }

    const settings = await getCaptchaSettings();

    if (settings.enabled) {
      const risk = settings.riskEnabled
        ? await computeRiskScore({ ip, ua: userAgent, sessionId, fingerprint, authPath: true })
        : null;
      const requiredDifficulty = await getRequiredDifficulty(user.id, sessionId, ip, risk);

      const required = risk?.requireCaptcha || requiredDifficulty !== 'easy';
      if (required) {
        const check = await assertCaptchaSatisfied({
          rayId: captchaRayId,
          sessionId,
          ipAddress: ip,
          userAgent,
          fingerprint,
          requiredDifficulty,
        });
        if (!check.ok) {
          return new NextResponse(check.error, { status: 403 });
        }
      }
    }

    if (user.is2FAEnabled) {
      // Suspicious sign-in from a new IP / device: challenge with an email OTP
      // first, then the authenticator 2FA code (OTP → 2FA). With no suspicious
      // activity, only the authenticator 2FA code is required.
      const lastSession2fa = await prisma.session.findFirst({
        where: { userId: user.id, status: { not: 'revoked' } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, ipAddress: true },
      });
      const isNewIp2fa = !lastSession2fa || lastSession2fa.ipAddress !== ip;
      const tempToken = await signTemp2faToken(user.id);
      return NextResponse.json({
        needs2FA: true,
        tempToken,
        ...(isNewIp2fa ? { needsOtp: true } : {}),
      });
    }

    // Suspicious sign-in from a new IP / location (no 2FA configured): challenge
    // with an email OTP before issuing a session instead of logging in directly.
    const lastSession = await prisma.session.findFirst({
      where: { userId: user.id, status: { not: 'revoked' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, ipAddress: true },
    });
    const isNewIp = !lastSession || lastSession.ipAddress !== ip;
    if (isNewIp) {
      return NextResponse.json({ needsOtp: true });
    }

    const adminRole = user.adminRole || user.roles?.[0]?.role?.name;
    const { token, refreshToken, sessionId: newSessionId } = await createSession(user.id, userAgent || undefined, ip, adminRole);
    const res = NextResponse.json({ id: user.id, email: user.email, token });
    setSessionCookie(res, token, refreshToken, request);

    // Fire-and-forget: clear rate limits, log security event, create notification, record device
    // These should NOT block the login response
    Promise.allSettled([
      Promise.resolve(clearRateLimitHits(ip)),
      Promise.resolve(logSecurityEvent({ request, userId: user.id, eventType: 'auth.login_success', details: { reason: 'password' } })),
      Promise.resolve(createNotification({
        userId: user.id,
        type: 'system',
        title: 'Signed in to your account',
        body: `New login from ${userAgent || 'Unknown device'}`,
        link: '/account/security',
      })),
      Promise.resolve(recordDeviceSeen({ fingerprint, userId: user.id, ip, ua: userAgent, sessionId })),
      // Record login history for the Login History section
      prisma.login_history.create({
        data: {
          userId: user.id,
          email: user.email,
          ipAddress: ip,
          userAgent: userAgent || null,
          success: true,
          method: 'password',
        },
      }).catch(() => {}),
      ...(isNewIp ? [sendTemplateEmail(user.email, 'login_alert', {
        name: user.email.split('@')[0],
        location: 'Unknown',
        device: userAgent || 'Unknown device',
        loginTime: new Date().toLocaleString(),
        revokeUrl: `https://dashboard.${process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app'}/settings/sessions`,
      })] : []),
    ]).catch(() => {});

    logPerformance('auth/login', loginStartTime, { userId: user.id, isNewIp });
    return res;
  } catch (err: any) {
    console.error('[LOGIN]', err?.message || err);
    return new NextResponse('Login failed', { status: 400 });
  }
}

export async function adminLoginHandler(request: NextRequest, preParsed?: z.infer<typeof loginSchema>) {
  try {
    const parsed = preParsed ? { success: true as const, data: preParsed } : loginSchema.safeParse(await request.json());
    if (!parsed.success) {
      return new NextResponse('Invalid email or password', { status: 400 });
    }
    const { email, password, captchaRayId, fingerprint: bodyFingerprint } = parsed.data;

    // The CaptchaWidget stores the device fingerprint in the __dfp cookie — fall
    // back to it (and the x-device-fingerprint header) so the risk score and
    // required difficulty match the challenge the user actually solved.
    const fingerprint = bodyFingerprint
      || request.cookies.get('__dfp')?.value
      || request.headers.get('x-device-fingerprint')
      || '';

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || '';
    const captchaSession = request.cookies.get('__captcha_session')?.value || 'anonymous';
    const sessionId = captchaSession;

    if (!checkWindowLimit(`admin:login:email:${email.toLowerCase()}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many sign-in attempts. Please try again later.', { status: 429 });
    }
    if (!checkWindowLimit(`admin:login:ip:${ip}`, 20, 15 * 60 * 1000)) {
      return new NextResponse('Too many sign-in attempts. Please try again later.', { status: 429 });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true, passwordHash: true, is2FAEnabled: true, isBanned: true, isSuspended: true, adminRole: true, mustChangePassword: true, roles: { include: { role: true } } },
    });
    if (!user) {
      logSecurityEvent({ request, eventType: 'auth.admin_login_failed', details: { reason: 'no_such_user' } }).catch(() => {});
      return new NextResponse('Invalid email or password', { status: 401 });
    }
    if (user.isBanned) {
      return new NextResponse('Account banned', { status: 403 });
    }
    if (user.isSuspended) {
      return new NextResponse('Account suspended', { status: 403 });
    }
    if (!user.passwordHash) {
      return new NextResponse('Invalid email or password', { status: 401 });
    }

    // Progressive friction: if this account/IP has prior failed-attempt history,
    // require a CAPTCHA before revealing password validity — so automated
    // password-spraying is challenged before the lockout threshold is reached.
    // A recent successful login from this IP clears the friction.

    const warnings = await getUserWarningCount(user.id, ip);
    const provenIdentity = await hasRecentLoginSuccess(ip);
    const forceCaptcha = !provenIdentity && (warnings.recentBlocks > 0 || warnings.count >= 2);
    if (forceCaptcha) {
      const requiredDifficulty = await getRequiredDifficulty(user.id, sessionId, ip, null);
      const check = await assertCaptchaSatisfied({
        rayId: captchaRayId,
        sessionId,
        ipAddress: ip,
        userAgent,
        fingerprint,
        requiredDifficulty,
      });
      if (!check.ok) {
        return new NextResponse(check.error, { status: 403 });
      }
    }

    if (!(await verifyPassword(user.passwordHash, password))) {
      recordRateLimitHit(ip);
      logSecurityEvent({ request, userId: user.id, eventType: 'auth.admin_login_failed', details: { reason: 'wrong_password' } }).catch(() => {});
      return new NextResponse('Invalid email or password', { status: 401 });
    }

    if (!user.adminRole && !user.roles?.[0]?.role) {
      logSecurityEvent({ request, userId: user.id, eventType: 'auth.admin_login_failed', details: { reason: 'not_admin' } }).catch(() => {});
      sendTemplateEmail(user.email, 'admin_alert', {
        subject: 'Unauthorized Admin Access Attempt',
        message: 'A user without admin privileges attempted to access the admin panel.',
        details: `<p>Email: ${user.email}</p><p>Time: ${new Date().toLocaleString()}</p>`,
        dashboardUrl: 'https://admin.tirbeo.app',
      }).catch(() => {});
      return new NextResponse('Access denied. You do not have admin privileges.', { status: 403 });
    }

    const settings = await getCaptchaSettings();

    if (settings.enabled) {
      const risk = settings.riskEnabled
        ? await computeRiskScore({ ip, ua: userAgent, sessionId, fingerprint, authPath: true })
        : null;
      const requiredDifficulty = await getRequiredDifficulty(user.id, sessionId, ip, risk);

      const required = risk?.requireCaptcha || requiredDifficulty !== 'easy';
      if (required) {
        const check = await assertCaptchaSatisfied({
          rayId: captchaRayId,
          sessionId,
          ipAddress: ip,
          userAgent,
          fingerprint,
          requiredDifficulty,
        });
        if (!check.ok) {
          return new NextResponse(check.error, { status: 403 });
        }
      }
    }

    if (user.is2FAEnabled) {
      const tempToken = await signTemp2faToken(user.id);
      return NextResponse.json({ needs2FA: true, tempToken });
    }

    // First-time admins (created with a temporary password) must set their own
    // password before any admin session is issued.
    if (user.mustChangePassword) {
      const tempToken = await signTempPasswordChangeToken(user.id);
      return NextResponse.json({ needsPasswordChange: true, tempToken });
    }

    const adminRole = user.adminRole || user.roles?.[0]?.role?.name;
    const { token, refreshToken, sessionId: newSessionId } = await createSession(user.id, userAgent || undefined, ip, adminRole);
    const res = NextResponse.json({ id: user.id, email: user.email, token });
    setSessionCookie(res, token, refreshToken, request);

    clearRateLimitHits(ip);
    logSecurityEvent({ request, userId: user.id, eventType: 'auth.admin_login_success', details: { reason: 'password' } }).catch(() => {});

    recordDeviceSeen({ fingerprint, userId: user.id, ip, ua: userAgent, sessionId }).catch(() => {});

    const lastSession = await prisma.session.findFirst({
      where: { userId: user.id, id: { not: newSessionId }, status: { not: 'revoked' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, ipAddress: true },
    });

    const isNewIp = !lastSession || lastSession.ipAddress !== ip;
    if (isNewIp) {
      const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
      sendTemplateEmail(user.email, 'login_alert', {
        name: user.email.split('@')[0],
        location: 'Admin Panel',
        device: userAgent || 'Unknown device',
        loginTime: new Date().toLocaleString(),
        revokeUrl: `https://dashboard.${appDomain}/settings/sessions`,
      }).catch(() => {});
    }

    return res;
  } catch (err: any) {
    console.error('[ADMIN LOGIN]', err?.message || err);
    return new NextResponse('Login failed', { status: 400 });
  }
}

export async function verify2faLoginHandler(request: NextRequest) {
  try {
    const { tempToken, token: totpToken, code } = (await request.json()) as any;
    const totpCode = (typeof totpToken === 'string' && totpToken) || (typeof code === 'string' && code) || '';
    if (typeof tempToken !== 'string' || totpCode.length === 0) {
      return new NextResponse('Invalid payload', { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (!checkWindowLimit(`2fa:ip:${clientIp}`, 15, 15 * 60 * 1000)) {
      return new NextResponse('Too many attempts. Please try again later.', { status: 429 });
    }

    const userId = await verifyTemp2faToken(tempToken);
    if (!userId) return new NextResponse('Invalid or expired temp token', { status: 401 });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, totpSecret: true, is2FAEnabled: true } });
    if (!user || !user.totpSecret || !user.is2FAEnabled) {
      return new NextResponse('2FA not enabled', { status: 400 });
    }

    if (!checkWindowLimit(`2fa:user:${userId}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many attempts. Please try again later.', { status: 429 });
    }

    if (!await verifyTotp(totpCode, user.totpSecret)) {
      logSecurityEvent({ request, userId, eventType: 'auth.2fa_failed', details: { reason: 'invalid_code' } }).catch(() => {});
      return new NextResponse('Invalid 2FA code', { status: 401 });
    }

    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, clientIp);
    const res = NextResponse.json({ id: user.id, email: user.email, token });
    setSessionCookie(res, token, refreshToken, request);

    clearRateLimitHits(clientIp);
    logSecurityEvent({ request, userId, eventType: 'auth.login_2fa_success', details: { reason: 'totp' } }).catch(() => {});
    return res;
  } catch {
    return new NextResponse('2FA verification failed', { status: 400 });
  }
}

export async function recovery2faLoginHandler(request: NextRequest) {
  try {
    const { tempToken, recoveryCode } = (await request.json()) as any;
    if (typeof tempToken !== 'string' || typeof recoveryCode !== 'string') {
      return new NextResponse('Invalid payload', { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (!checkWindowLimit(`2fa-recovery:ip:${clientIp}`, 10, 15 * 60 * 1000)) {
      return new NextResponse('Too many attempts. Please try again later.', { status: 429 });
    }

    const userId = await verifyTemp2faToken(tempToken);
    if (!userId) return new NextResponse('Invalid or expired temp token', { status: 401 });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, is2FAEnabled: true } });
    if (!user || !user.is2FAEnabled) {
      return new NextResponse('2FA not enabled', { status: 400 });
    }

    const codes = await prisma.recoveryCode.findMany({
      where: { userId, used: false },
      orderBy: { createdAt: 'asc' },
    });
    const inputHash = hashRecoveryCode(recoveryCode);
    const rc = codes.find(c => c.code === inputHash) || null;
    if (!rc) return new NextResponse('Invalid recovery code', { status: 401 });

    await prisma.recoveryCode.update({
      where: { id: rc.id },
      data: { used: true, usedAt: new Date() },
    });

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.json({ id: user.id, email: user.email, token });
    setSessionCookie(res, token, refreshToken, request);
    return res;
  } catch {
    return new NextResponse('Recovery code verification failed', { status: 400 });
  }
}

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  username: z.string().min(3).max(30),
  dob: z.string().optional(),
  gender: z.string().optional(),
  photoUrl: z.string().url().optional().or(z.literal('')),
  occupation: z.string().optional(),
  companyName: z.string().optional().or(z.literal('')),
  role: z.string().max(100).optional(),
  recoveryEmail: z.string().email().optional().or(z.literal('')),
  // Client-generated TOTP secret + flag when the user set up 2FA during signup.
  totpSecret: z.string().optional(),
  is2FAEnabled: z.boolean().optional(),
  policyAccepted: z.boolean(),
  adminDataAccess: z.boolean().optional(),
  turnstileToken: z.string().optional(),
  captchaRayId: z.string().optional(),
  fingerprint: z.string().optional(),
  // Optional pre-verified signup OTP (requested via auth/signup-otp/request,
  // verified without consuming via auth/signup-otp/verify). When valid, the
  // account is created with emailVerified=true and no verify email is sent.
  otpCode: z.string().optional(),
});

export async function emailExistsHandler(request: NextRequest) {
  try {
    const body: any = await request.json();
    const email = (body?.email || '').toString().toLowerCase().trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ exists: false, hasPassword: false }, { status: 200 });
    }
    const cached = emailExistsCache.get(email);
    if (cached) return NextResponse.json(cached, { status: 200 });

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, photoUrl: true, name: true, secondaryEmail: true },
    });
    const result = {
      exists: !!user,
      hasPassword: !!user?.passwordHash,
      photoUrl: user?.photoUrl || null,
      name: user?.name || null,
      hasRecoveryEmail: !!user?.secondaryEmail,
      recoveryEmail: user?.secondaryEmail ? maskEmail(user.secondaryEmail) : null,
    };
    emailExistsCache.set(email, result);
    return NextResponse.json(result, { status: 200 });
  } catch (err: any) {
    console.error('[EMAIL-EXISTS]', err?.message || err);
    return NextResponse.json({ error: 'Could not check email' }, { status: 500 });
  }
}

export async function usernameExistsHandler(request: NextRequest) {
  try {
    const body: any = await request.json();
    const username = (body?.username || '').toString().toLowerCase().trim();
    
    // Validate username format: lowercase alphanumeric with hyphens, 3-30 chars
    if (!username || username.length < 3 || username.length > 30) {
      return NextResponse.json({ exists: false, valid: false }, { status: 200 });
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(username)) {
      return NextResponse.json({ exists: false, valid: false }, { status: 200 });
    }
    
    // Check for reserved words
    const reserved = ['admin', 'api', 'www', 'mail', 'support', 'help', 'info', 'blog', 'docs', 'status', 'app', 'web', 'dev', 'test', 'null', 'undefined', 'true', 'false', 'root', 'system', 'settings', 'config', 'auth', 'login', 'signup', 'dashboard'];
    if (reserved.includes(username)) {
      return NextResponse.json({ exists: true, valid: true, reserved: true }, { status: 200 });
    }
    
    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    return NextResponse.json({
      exists: !!user,
      valid: true,
      reserved: false,
    }, { status: 200 });
  } catch (err: any) {
    console.error('[USERNAME-EXISTS]', err?.message || err);
    return NextResponse.json({ error: 'Could not check username' }, { status: 500 });
  }
}

export async function signupHandler(request: NextRequest) {
  try {
    const parsed = signupSchema.safeParse(await request.json());
    if (!parsed.success) {
      console.error('[SIGNUP] Validation failed:', parsed.error.flatten());
      return new NextResponse('Invalid request payload', { status: 400 });
    }
    const { email, password, firstName, lastName, username, dob, gender, photoUrl, occupation, companyName, role, recoveryEmail, totpSecret, is2FAEnabled, policyAccepted, adminDataAccess, captchaRayId, fingerprint, otpCode } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedUsername = username.toString().trim().toLowerCase();
    const normalizedPhotoUrl = photoUrl ? photoUrl.toString().trim() : undefined;
    const normalizedCompanyName = companyName ? companyName.toString().trim() : undefined;
    const normalizedOccupation = occupation ? sanitizeInput(occupation, 120).trim() : undefined;
    const normalizedRole = role ? sanitizeInput(role, 100).trim() : undefined;
    const normalizedRecoveryEmail = recoveryEmail ? recoveryEmail.toString().trim().toLowerCase() : undefined;
    const normalizedTotpSecret = totpSecret ? totpSecret.toString().trim() : undefined;
    

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || '';
    const captchaSession = request.cookies.get('__captcha_session')?.value || 'anonymous';

    if (!policyAccepted) {
      return new NextResponse('Policy acceptance is required', { status: 400 });
    }

    // Relaxed rate limits for signup - 20 per hour per IP, 10 per hour per email
    if (!checkWindowLimit(`signup:ip:${ip}`, 20, 60 * 60 * 1000)) {
      return new NextResponse('Too many sign-up attempts. Please try again later.', { status: 429 });
    }
    if (!checkWindowLimit(`signup:email:${email.toLowerCase()}`, 10, 60 * 60 * 1000)) {
      return new NextResponse('Too many sign-up attempts. Please try again later.', { status: 429 });
    }

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      return new NextResponse('Email already registered', { status: 409 });
    }

    if (normalizedUsername) {
      const existingUsername = await prisma.user.findUnique({ where: { username: normalizedUsername } });
      if (existingUsername) {
        return new NextResponse('Username already taken', { status: 409 });
      }
    }

    const settings = await getCaptchaSettings();
    if (settings.enabled) {
      const risk = settings.riskEnabled
        ? await computeRiskScore({ ip, ua: userAgent, sessionId: captchaSession, fingerprint, authPath: true })
        : null;
      const requiredDifficulty = await getRequiredDifficulty(undefined, captchaSession, ip, risk);
      const required = risk?.requireCaptcha || requiredDifficulty !== 'easy';
      if (required) {
        const check = await assertCaptchaSatisfied({
          rayId: captchaRayId,
          sessionId: captchaSession,
          ipAddress: ip,
          userAgent,
          fingerprint,
          requiredDifficulty,
        });
        if (!check.ok) {
          return new NextResponse(check.error, { status: 403 });
        }
      }
    }

    // If the user pre-verified their email via signup-otp, validate the code
    // (this consumes it) and create the account already email-verified.
    let preVerifiedEmail = false;
    if (otpCode) {
      preVerifiedEmail = await verifySignupOtp(normalizedEmail, otpCode);
      if (!preVerifiedEmail) {
        return new NextResponse('Invalid or expired verification code', { status: 400 });
      }
    }

    const breach = await checkPasswordBreach(password);
    if (breach.breached) {
      return new NextResponse('This password has been found in known breaches. Please choose a different password.', { status: 400 });
    }

    const passwordHash = await hashPassword(password);
    const name = sanitizeInput(`${firstName} ${lastName}`.trim(), 200);
    const birthday = dob ? new Date(dob) : undefined;
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        name,
        username: normalizedUsername,
        photoUrl: normalizedPhotoUrl || undefined,
        occupation: normalizedOccupation,
        companyName: normalizedCompanyName ? sanitizeInput(normalizedCompanyName, 120) : undefined,
        companyRole: normalizedRole || undefined,
        secondaryEmail: normalizedRecoveryEmail || undefined,
        totpSecret: normalizedTotpSecret || undefined,
        is2FAEnabled: !!(is2FAEnabled && normalizedTotpSecret),
        gender: gender ? sanitizeInput(gender, 100) : undefined,
        birthday,
        // Email can ONLY be marked verified through the signup OTP flow — a
        // client-supplied flag is never trusted (would allow claiming a
        // verified account without proving email ownership).
        emailVerified: preVerifiedEmail,
        preferences: {
          signupConsent: {
            acceptedAt: new Date().toISOString(),
            policyAccepted: true,
            adminDataAccess: !!adminDataAccess,
          },
        },
      },
    });

    const { token, refreshToken } = await createSession(user.id, userAgent || undefined, ip);
    const res = NextResponse.json({ id: user.id, email: user.email, token }, { status: 201 });
    setSessionCookie(res, token, refreshToken, request);

    recordDeviceSeen({ fingerprint, userId: user.id, ip, ua: userAgent, sessionId: captchaSession }).catch(() => {});

    // Send welcome email (non-blocking)
    sendTemplateEmail(email, 'welcome', { name: name || email.split('@')[0] }, {
      fromEmail: 'noreply@send.tirbeo.app',
      fromName: 'Tirbeo',
    }).catch(err => console.error('[SIGNUP] Welcome email failed:', err?.message));

    // Create welcome notification
    createNotification({
      userId: user.id,
      type: 'system',
      title: 'Welcome to Tirbeo!',
      body: 'Your account has been created successfully. Start by exploring the dashboard.',
      link: '/overview',
    }).catch(() => {});

    // Send verification OTP — unless the user already verified via signup-otp
    if (!preVerifiedEmail) {
      const verifyCode = Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => (b % 10).toString()).join('');
      const otpHash = hashOtpCode(verifyCode);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await prisma.otp.create({
        data: { userId: user.id, type: 'email', otpHash, expiresAt },
      });
      sendTemplateEmail(email, 'verify_email', { otp: verifyCode, name: name || email.split('@')[0] }, {
        fromEmail: 'noreply@send.tirbeo.app',
        fromName: 'Tirbeo',
      }).catch(err => console.error('[SIGNUP] Verification email failed:', err?.message));
    }

    return res;
  } catch (err: any) {
    console.error('[SIGNUP]', err?.message || err, err?.stack);
    return new NextResponse('Signup failed', { status: 400 });
  }
}

export async function requestSignupOtpHandler(request: NextRequest) {
  try {
    const { email } = (await request.json()) as any;
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    // Relaxed OTP rate limits - 10 per hour per IP, 5 per hour per email
    if (!checkWindowLimit(`signup-otp:ip:${clientIp}`, 10, 15 * 60 * 1000)) {
      return new NextResponse('Too many requests. Please try again later.', { status: 429 });
    }
    if (!checkWindowLimit(`signup-otp:email:${email.toLowerCase()}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many requests. Please try again later.', { status: 429 });
    }

    const cooldown = enforceResendCooldown(`signup-otp:${email.toLowerCase()}`);
    if (!cooldown.allowed) {
      return NextResponse.json(
        { message: 'Please wait before requesting another code.', retryAfterMs: cooldown.remainingMs },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(cooldown.remainingMs / 1000)) } },
      );
    }

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) {
      return new NextResponse('Email already registered', { status: 409 });
    }

    const code = genSignupOtp();
    await storeSignupOtp(email, code);
    let emailSent = false;
    try {
      const result = await sendSignupOtpEmail(email, code);
      emailSent = result.success;
    } catch (emailErr) {
      console.error('[SIGNUP OTP] Email send error:', emailErr);
    }
    return NextResponse.json({ message: 'Verification code sent to email' }, { status: 200 });
  } catch (err: any) {
    console.error('[SIGNUP OTP REQUEST]', err?.message || err, err?.stack);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

// Verify a pre-signup OTP without consuming it (final consumption happens at auth/signup)
export async function signupOtpVerifyHandler(request: NextRequest) {
  try {
    const { email, code } = (await request.json()) as any;
    if (!email || typeof email !== 'string' || !code || typeof code !== 'string') {
      return new NextResponse('Email and code are required', { status: 400 });
    }

    const ok = await checkSignupOtp(email, code);
    if (!ok) {
      return new NextResponse('Invalid or expired verification code', { status: 400 });
    }
    return NextResponse.json({ verified: true });
  } catch (err: any) {
    console.error('[SIGNUP OTP VERIFY]', err?.message || err);
    return new NextResponse('Verification failed', { status: 500 });
  }
}

// Record policy consent for an OAuth-created account (no password yet) so the
// user can be routed to the dashboard afterwards.
export async function oauthConsentHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body: any = await request.json();
    const { policyAccepted, adminDataAccess, signatureName } = body;
    if (!policyAccepted) {
      return new NextResponse('Policy acceptance is required', { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, email: true, preferences: true } });
    if (!user) return new NextResponse('User not found', { status: 404 });

    const prefs: any = (user.preferences as any) || {};
    prefs.signupConsent = {
      acceptedAt: new Date().toISOString(),
      policyAccepted: true,
      adminDataAccess: !!adminDataAccess,
      signatureName: signatureName ? sanitizeInput(signatureName, 200).trim() : (user.email ? user.email.split('@')[0] : ''),
      oauth: true,
    };

    await prisma.user.update({
      where: { id: user.id },
      data: { preferences: prefs, emailVerified: true },
    });

    return NextResponse.json({ ok: true, message: 'Consent recorded' });
  } catch (err: any) {
    console.error('[OAUTH CONSENT]', err?.message || err);
    return new NextResponse('Failed to record consent', { status: 500 });
  }
}

export async function requestLoginOtpHandler(request: NextRequest) {
  try {
    const { email } = (await request.json()) as any;
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    // Relaxed login OTP rate limits - 10 per hour per IP, 5 per hour per email
    if (!checkWindowLimit(`login-otp:ip:${clientIp}`, 10, 15 * 60 * 1000)) {
      return new NextResponse('Too many requests. Please try again later.', { status: 429 });
    }
    if (!checkWindowLimit(`login-otp:email:${email.toLowerCase()}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many requests. Please try again later.', { status: 429 });
    }

    const cooldown = enforceResendCooldown(`login-otp:${email.toLowerCase()}`);
    if (!cooldown.allowed) {
      return NextResponse.json(
        { message: 'Please wait before requesting another code.', retryAfterMs: cooldown.remainingMs },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(cooldown.remainingMs / 1000)) } },
      );
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) {
      return NextResponse.json({ message: 'If an account exists, a code has been sent.' });
    }

    const code = genSignupOtp();
    await storeSignupOtp(email, code);
    let emailSent = false;
    try {
      const result = await sendSignupOtpEmail(email, code, 'login_otp');
      emailSent = result.success;
    } catch (emailErr) {
      console.error('[LOGIN OTP] Email send error:', emailErr);
    }
    return NextResponse.json({ message: 'Verification code sent to your email' }, { status: 200 });
  } catch (err: any) {
    console.error('[LOGIN OTP REQUEST]', err?.message || err, err?.stack);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

export async function verifyLoginOtpHandler(request: NextRequest) {
  try {
    const { email, otpCode } = (await request.json()) as any;
    if (!email || typeof email !== 'string' || !otpCode || typeof otpCode !== 'string') {
      return new NextResponse('Email and code are required', { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true, email: true, isBanned: true, isSuspended: true, emailVerified: true, is2FAEnabled: true } });
    if (!user) {
      return new NextResponse('Invalid email or code', { status: 401 });
    }
    if (user.isBanned || user.isSuspended) {
      return new NextResponse('Account suspended', { status: 403 });
    }
    if (!user.emailVerified) {
      return new NextResponse('Please verify your email before signing in', { status: 403 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (!checkWindowLimit(`login-otp-verify:ip:${clientIp}`, 10, 15 * 60 * 1000)) {
      return new NextResponse('Too many attempts. Please try again later.', { status: 429 });
    }

    const otpOk = await verifySignupOtp(email, otpCode);
    if (!otpOk) {
      logSecurityEvent({ request, userId: user.id, eventType: 'auth.login_failed', details: { reason: 'invalid_otp' } }).catch(() => {});
      return new NextResponse('Invalid or expired verification code', { status: 400 });
    }

    // If 2FA is enabled, always require the authenticator code before issuing
    // a session — even after a successful email OTP (suspicious login).
    if (user.is2FAEnabled) {
      const tempToken = await signTemp2faToken(user.id);
      return NextResponse.json({ requiresMfa: true, tempToken });
    }

    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, clientIp);
    const res = NextResponse.json({ id: user.id, email: user.email, token });
    setSessionCookie(res, token, refreshToken, request);

    clearRateLimitHits(clientIp);
    logSecurityEvent({ request, userId: user.id, eventType: 'auth.login_otp_success', details: { reason: 'suspicious_login_otp' } }).catch(() => {});
    return res;
  } catch (err) {
    console.error('[LOGIN OTP VERIFY]', err);
    return new NextResponse('Verification failed', { status: 500 });
  }
}

export async function logoutHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (session && session.sessionId !== 'cli') {
      await revokeSession(session.sessionId);
    }
    const res = new NextResponse('Logged out', { status: 200 });
    clearSessionCookie(res);
    return res;
  } catch {
    return new NextResponse('Logout failed', { status: 400 });
  }
}

export async function sessionRevokeByTokenHandler(request: NextRequest) {
  try {
    const { token } = (await request.json()) as any;
    if (!token || typeof token !== 'string') return new NextResponse('Token required', { status: 400 });
    const sessionId = await verifySessionRevokeToken(token);
    if (!sessionId) return new NextResponse('Invalid or expired token', { status: 401 });
    await revokeSession(sessionId);
    return new NextResponse('Session revoked', { status: 200 });
  } catch {
    return new NextResponse('Failed to revoke session', { status: 400 });
  }
}

// Email OTP - request
export async function requestEmailOtpHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, email: true } });
    if (!user || !user.email) return new NextResponse('User email missing', { status: 400 });
    const cooldown = enforceResendCooldown(`email-otp:${user.id}`);
    if (!cooldown.allowed) {
      return NextResponse.json(
        { message: 'Please wait before requesting another code.', retryAfterMs: cooldown.remainingMs },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(cooldown.remainingMs / 1000)) } },
      );
    }
    const code = generateOtpCode();
    await storeOtp(session.userId, 'email', code);
    await sendEmailOtp(user.email, code);
    return new NextResponse('OTP sent to email', { status: 200 });
  } catch (err: any) {
    console.error('[EMAIL OTP REQUEST]', err?.message || err);
    return new NextResponse('Failed to send OTP', { status: 500 });
  }
}

// Email OTP - verify
export async function verifyEmailOtpHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });
    const { code, email } = (await request.json()) as any;
    if (typeof code !== 'string') return new NextResponse('Invalid OTP payload', { status: 400 });
    const ok = await verifyOtpCode(session.userId, 'email', code);
    if (!ok) return new NextResponse('Invalid or expired OTP', { status: 400 });
    if (email && typeof email === 'string') {
      await prisma.user.update({
        where: { id: session.userId },
        data: { secondaryEmail: email },
      });
    }
    return new NextResponse('Email OTP verified', { status: 200 });
  } catch (err: any) {
    console.error('[EMAIL OTP VERIFY]', err?.message || err);
    return new NextResponse('OTP verification failed', { status: 500 });
  }
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Email change / verification - send code to the target email
export async function changeEmailRequestHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });
    const body: any = await request.json();
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || !EMAIL_REGEX.test(email)) {
      return new NextResponse('Enter a valid email address', { status: 400 });
    }
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, email: true, emailVerified: true } });
    if (!user) return new NextResponse('User not found', { status: 404 });

    const isCurrent = user.email?.toLowerCase() === email;
    if (isCurrent && user.emailVerified) {
      return new NextResponse('Your email is already verified', { status: 400 });
    }
    if (!isCurrent) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) return new NextResponse('That email is already in use', { status: 400 });
    }

    const cooldown = enforceResendCooldown(`change-email:${user.id}`);
    if (!cooldown.allowed) {
      return NextResponse.json(
        { message: 'Please wait before requesting another code.', retryAfterMs: cooldown.remainingMs },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(cooldown.remainingMs / 1000)) } },
      );
    }
    const code = generateOtpCode();
    await storeOtp(user.id, 'email_verify', code);
    await sendEmailOtp(email, code);
    return new NextResponse('Verification code sent', { status: 200 });
  } catch (err: any) {
    console.error('[CHANGE EMAIL REQUEST]', err?.message || err);
    return new NextResponse('Failed to send verification code', { status: 500 });
  }
}

// Email change / verification - verify code and update the primary email
export async function changeEmailVerifyHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });
    const body: any = await request.json();
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!code) return new NextResponse('Enter the verification code', { status: 400 });
    if (!email || !EMAIL_REGEX.test(email)) {
      return new NextResponse('Enter a valid email address', { status: 400 });
    }
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, email: true, emailVerified: true } });
    if (!user) return new NextResponse('User not found', { status: 404 });

    const ok = await verifyOtpCode(user.id, 'email_verify', code);
    if (!ok) return new NextResponse('Invalid or expired verification code', { status: 400 });

    const currentEmail = user.email?.toLowerCase();
    if (currentEmail !== email) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing && existing.id !== user.id) {
        return new NextResponse('That email is already in use', { status: 400 });
      }
      await prisma.user.update({ where: { id: user.id }, data: { email, emailVerified: true } });
    } else if (!user.emailVerified) {
      await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    }

    createNotification({
      userId: user.id,
      type: 'security',
      title: 'Email updated',
      body: currentEmail === email ? 'Your email was verified.' : `Your email was updated to ${email}.`,
      link: '/account/profile',
    }).catch((e: Error) => console.error('[NOTIFICATION]', e?.message));

    return new NextResponse('Email verified', { status: 200 });
  } catch (err: any) {
    console.error('[CHANGE EMAIL VERIFY]', err?.message || err);
    return new NextResponse('Verification failed', { status: 500 });
  }
}

// Signup email verification (no session required)
export async function verifySignupEmailHandler(request: NextRequest) {
  try {
    const { email, code } = (await request.json()) as any;
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }
    if (code && typeof code !== 'string') {
      return new NextResponse('Invalid verification code', { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return new NextResponse('Invalid email or code', { status: 400 });

    // Resend request — generate a new OTP and email it again
    if (!code) {
      const cooldown = enforceResendCooldown(`verify-email:${email.toLowerCase()}`);
      if (!cooldown.allowed) {
        return NextResponse.json(
          { message: 'Please wait before requesting another code.', retryAfterMs: cooldown.remainingMs },
          { status: 429, headers: { 'Retry-After': String(Math.ceil(cooldown.remainingMs / 1000)) } },
        );
      }
      const otpCode = Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => (b % 10).toString()).join('');
      const otpHash = hashOtpCode(otpCode);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await prisma.otp.create({
        data: { userId: user.id, type: 'email', otpHash, expiresAt },
      });
      sendTemplateEmail(email, 'verify_email', { otp: otpCode, name: user.name || email.split('@')[0] }, {
        fromEmail: 'noreply@send.tirbeo.app',
        fromName: 'Tirbeo',
      }).catch(err => console.error('[SIGNUP] Resend verification email failed:', err?.message));
      return new NextResponse('Verification code resent', { status: 200 });
    }

    const ok = await verifyOtpCode(user.id, 'email', code);
    if (!ok) return new NextResponse('Invalid or expired verification code', { status: 400 });

    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    });

    return new NextResponse('Email verified successfully', { status: 200 });
  } catch (err: any) {
    console.error('[SIGNUP EMAIL VERIFY]', err?.message || err);
    return new NextResponse('Verification failed', { status: 500 });
  }
}

// Phone OTP - request
export async function requestPhoneOtpHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, phoneNumber: true } });
    if (!user || !user.phoneNumber) return new NextResponse('User phone missing', { status: 400 });
    const code = generateOtpCode();
    await storeOtp(session.userId, 'phone', code);
    await sendPhoneOtp(user.phoneNumber, code);
    return new NextResponse('OTP sent to phone', { status: 200 });
  } catch (err: any) {
    console.error('[PHONE OTP REQUEST]', err?.message || err);
    return new NextResponse('Failed to send OTP', { status: 500 });
  }
}

// Phone OTP - verify
export async function verifyPhoneOtpHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });
    const { code } = (await request.json()) as any;
    if (typeof code !== 'string') return new NextResponse('Invalid OTP payload', { status: 400 });
    const ok = await verifyOtpCode(session.userId, 'phone', code);
    if (!ok) return new NextResponse('Invalid or expired OTP', { status: 400 });
    return new NextResponse('Phone OTP verified', { status: 200 });
  } catch (err: any) {
    console.error('[PHONE OTP VERIFY]', err?.message || err);
    return new NextResponse('OTP verification failed', { status: 500 });
  }
}

// Google OAuth - start flow
export async function googleAuthRedirectHandler(request: NextRequest) {
  try {
    const cfg = await getOauthProviderConfig('google');
    const clientId = cfg.clientId;
    const redirectUri = cfg.redirectUri || getDynamicRedirectUri(request, '/auth/google/callback');
    if (!cfg.enabled || !clientId || !redirectUri) {
      return new NextResponse('Google OAuth not configured', { status: 500 });
    }
    const sp = request.nextUrl.searchParams;
    const redirectTo = sp.get('redirect_to') || sp.get('redirect');
    const safeRedirect = redirectTo && isAllowedRedirect(redirectTo) ? redirectTo : undefined;
    const isLink = sp.get('link') === '1';
    const nonce = crypto.randomUUID();
    const stateToken = await signOauthStateToken(nonce, safeRedirect, isLink);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
      state: stateToken,
    });
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    const res = NextResponse.redirect(googleAuthUrl);
    setOauthStateCookie(res, nonce, request);
    return res;
  } catch (err: any) {
    console.error('[GOOGLE AUTH]', err?.message || err);
    return new NextResponse('Failed to initiate Google auth', { status: 500 });
  }
}

// Google OAuth callback handler
export async function googleAuthCallbackHandler(request: NextRequest) {
  try {
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (!checkWindowLimit(`oauth-cb:ip:${clientIp}`, 10, 15 * 60 * 1000)) {
      return new NextResponse('Too many attempts. Please try again later.', { status: 429 });
    }
    const cfg = await getOauthProviderConfig('google');
    const clientId = cfg.clientId;
    const clientSecret = cfg.clientSecret;
    const redirectUri = cfg.redirectUri || getDynamicRedirectUri(request, '/auth/google/callback');
    if (!cfg.enabled || !clientId || !clientSecret || !redirectUri) {
      return new NextResponse('Google OAuth not configured', { status: 500 });
    }
    const code = request.nextUrl.searchParams.get('code');
    const stateParam = request.nextUrl.searchParams.get('state');
    const cookieNonce = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
    const state = stateParam ? await verifyOauthStateToken(stateParam) : null;
    if (!state || !cookieNonce || state.nonce !== cookieNonce) {
      return new NextResponse('Invalid OAuth state', { status: 400 });
    }
    const redirectTo = state.redirect && isAllowedRedirect(state.redirect) ? state.redirect : undefined;
    if (!code) {
      return new NextResponse('Missing code', { status: 400 });
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('[GOOGLE TOKEN EXCHANGE] Failed:', tokenRes.status, errBody, 'redirect_uri:', redirectUri, 'client_id:', clientId?.slice(0, 20));
      return new NextResponse('Failed to exchange token', { status: 500 });
    }
    const tokenData: any = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userInfoRes.ok) {
      return new NextResponse('Failed to fetch user info', { status: 500 });
    }
    const profile: any = await userInfoRes.json();
    const googleId = profile.id as string;
    const email = profile.email as string;
    const name = profile.name as string;
    const photoUrl = profile.picture as string | undefined;

    let user = await prisma.user.findUnique({ where: { googleId: googleId } });
    if (!user) {
      user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        await prisma.user.update({
          where: { id: user.id },
          data: { googleId: googleId, photoUrl: user.photoUrl || photoUrl || undefined },
        });
      } else {
        user = await prisma.user.create({
          data: {
            email, name, googleId: googleId, photoUrl: photoUrl || undefined,
          },
        });
        await prisma.auditEvent.create({
          data: { actorId: user.id, action: 'user.created', targetType: 'user', targetId: user.id, metadata: { provider: 'google', email } },
        });
      }
    } else {
      if (!user.photoUrl && photoUrl) {
        await prisma.user.update({ where: { id: user.id }, data: { photoUrl } });
      }
    }

    await prisma.integration.upsert({
      where: { userId_provider: { userId: user.id, provider: 'google' } },
      update: { connected: true, metadata: { googleId, email } },
      create: { userId: user.id, provider: 'google', connected: true, metadata: { googleId, email } },
    });

    // Link mode: user is already logged in, just record integration and redirect back
    if (state.link) {
      const existingSession = await getSession(request);
      if (existingSession) {
        await prisma.integration.upsert({
          where: { userId_provider: { userId: existingSession.userId, provider: 'google' } },
          update: { connected: true, metadata: { googleId, email } },
          create: { userId: existingSession.userId, provider: 'google', connected: true, metadata: { googleId, email } },
        });
        const res = NextResponse.redirect(new URL('/account/apps', request.url));
        clearOauthStateCookie(res, request);
        return res;
      }
      // Not logged in — fall through to normal login
    }

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const target = oauthPostLoginTarget(user, redirectTo, 'google');
    const res = NextResponse.redirect(target);
    setSessionCookie(res, token, refreshToken, request);
    clearOauthStateCookie(res, request);
    return res;
  } catch (err: any) {
    console.error('[GOOGLE CALLBACK]', err?.message || err);
    return new NextResponse('Google OAuth callback failed', { status: 500 });
  }
}

// GitHub OAuth - start flow
export async function githubAuthRedirectHandler(request: NextRequest) {
  try {
    const cfg = await getOauthProviderConfig('github');
    const clientId = cfg.clientId;
    const redirectUri = cfg.redirectUri || getDynamicRedirectUri(request, '/auth/github/callback');
    if (!cfg.enabled || !clientId || !redirectUri) {
      return new NextResponse('GitHub OAuth not configured', { status: 500 });
    }
    const sp = request.nextUrl.searchParams;
    const redirectTo = sp.get('redirect_to') || sp.get('redirect');
    const safeRedirect = redirectTo && isAllowedRedirect(redirectTo) ? redirectTo : undefined;
    const isLink = sp.get('link') === '1';
    const nonce = crypto.randomUUID();
    const stateToken = await signOauthStateToken(nonce, safeRedirect, isLink);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state: stateToken,
    });
    const githubAuthUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    const res = NextResponse.redirect(githubAuthUrl);
    setOauthStateCookie(res, nonce, request);
    return res;
  } catch (err: any) {
    console.error('[GITHUB AUTH]', err?.message || err);
    return new NextResponse('Failed to initiate GitHub auth', { status: 500 });
  }
}

// GitHub OAuth callback handler
export async function githubAuthCallbackHandler(request: NextRequest) {
  try {
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (!checkWindowLimit(`oauth-cb:ip:${clientIp}`, 10, 15 * 60 * 1000)) {
      return new NextResponse('Too many attempts. Please try again later.', { status: 429 });
    }
    const cfg = await getOauthProviderConfig('github');
    const clientId = cfg.clientId;
    const clientSecret = cfg.clientSecret;
    const redirectUri = cfg.redirectUri || getDynamicRedirectUri(request, '/auth/github/callback');
    if (!cfg.enabled || !clientId || !clientSecret || !redirectUri) {
      return new NextResponse('GitHub OAuth not configured', { status: 500 });
    }
    const code = request.nextUrl.searchParams.get('code');
    const stateParam = request.nextUrl.searchParams.get('state');
    const cookieNonce = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
    const state = stateParam ? await verifyOauthStateToken(stateParam) : null;
    if (!state || !cookieNonce || state.nonce !== cookieNonce) {
      return new NextResponse('Invalid OAuth state', { status: 400 });
    }
    if (!code) {
      return new NextResponse('Missing code', { status: 400 });
    }

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    });
    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('[GITHUB TOKEN EXCHANGE] Failed:', tokenRes.status, errBody, 'redirect_uri:', redirectUri);
      return new NextResponse('Failed to exchange token', { status: 500 });
    }
    const tokenData: any = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const userInfoRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userInfoRes.ok) {
      return new NextResponse('Failed to fetch user info', { status: 500 });
    }
    const profile: any = await userInfoRes.json();
    const githubId = String(profile.id);
    let email = profile.email;
    const name = profile.name || profile.login;
    const photoUrl = profile.avatar_url as string | undefined;

    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (emailsRes.ok) {
        const emails: any = await emailsRes.json();
        const primary = emails.find((e: any) => e.primary) || emails[0];
        if (primary) email = primary.email;
      }
    }

    let user = await prisma.user.findUnique({ where: { githubId: githubId } });
    if (!user && email) {
      user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        await prisma.user.update({
          where: { id: user.id },
          data: { githubId: githubId, photoUrl: user.photoUrl || photoUrl || undefined },
        });
      } else {
        user = await prisma.user.create({
          data: {
            email: email || `${githubId}@github.user`, name, githubId: githubId,
            photoUrl: photoUrl || undefined,
          },
        });
        await prisma.auditEvent.create({
          data: { actorId: user.id, action: 'user.created', targetType: 'user', targetId: user.id, metadata: { provider: 'github', email } },
        });
      }
    } else if (user) {
      if (!user.photoUrl && photoUrl) {
        await prisma.user.update({ where: { id: user.id }, data: { photoUrl } });
      }
    } else {
      return new NextResponse('GitHub email not available', { status: 400 });
    }

    await prisma.integration.upsert({
      where: { userId_provider: { userId: user.id, provider: 'github' } },
      update: { connected: true, metadata: { githubId, email } },
      create: { userId: user.id, provider: 'github', connected: true, metadata: { githubId, email } },
    });

    // Link mode: user is already logged in, just record integration and redirect back
    if (state.link) {
      const existingSession = await getSession(request);
      if (existingSession) {
        await prisma.integration.upsert({
          where: { userId_provider: { userId: existingSession.userId, provider: 'github' } },
          update: { connected: true, metadata: { githubId, email } },
          create: { userId: existingSession.userId, provider: 'github', connected: true, metadata: { githubId, email } },
        });
        const res = NextResponse.redirect(new URL('/account/apps', request.url));
        clearOauthStateCookie(res, request);
        return res;
      }
    }

    const redirectTo = state.redirect && isAllowedRedirect(state.redirect) ? state.redirect : undefined;
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const target = oauthPostLoginTarget(user, redirectTo, 'github');
    const res = NextResponse.redirect(target);
    setSessionCookie(res, token, refreshToken, request);
    clearOauthStateCookie(res, request);
    return res;
  } catch (err: any) {
    console.error('[GITHUB CALLBACK]', err?.message || err);
    return new NextResponse('GitHub OAuth callback failed', { status: 500 });
  }
}

// Discord OAuth - start flow
export async function discordAuthRedirectHandler(request: NextRequest) {
  try {
    const cfg = await getOauthProviderConfig('discord');
    const clientId = cfg.clientId;
    const redirectUri = cfg.redirectUri || getDynamicRedirectUri(request, '/auth/discord/callback');
    if (!cfg.enabled || !clientId || !redirectUri) {
      return new NextResponse('Discord OAuth not configured', { status: 500 });
    }
    const sp = request.nextUrl.searchParams;
    const redirectTo = sp.get('redirect_to') || sp.get('redirect');
    const safeRedirect = redirectTo && isAllowedRedirect(redirectTo) ? redirectTo : undefined;
    const isLink = sp.get('link') === '1';
    const nonce = crypto.randomUUID();
    const stateToken = await signOauthStateToken(nonce, safeRedirect, isLink);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify email',
      state: stateToken,
    });
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?${params.toString()}`;
    const res = NextResponse.redirect(discordAuthUrl);
    setOauthStateCookie(res, nonce, request);
    return res;
  } catch (err: any) {
    console.error('[DISCORD AUTH]', err?.message || err);
    return new NextResponse('Failed to initiate Discord auth', { status: 500 });
  }
}

// Discord OAuth callback handler
export async function discordAuthCallbackHandler(request: NextRequest) {
  try {
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (!checkWindowLimit(`oauth-cb:ip:${clientIp}`, 10, 15 * 60 * 1000)) {
      return new NextResponse('Too many attempts. Please try again later.', { status: 429 });
    }
    const cfg = await getOauthProviderConfig('discord');
    const clientId = cfg.clientId;
    const clientSecret = cfg.clientSecret;
    const redirectUri = cfg.redirectUri || getDynamicRedirectUri(request, '/auth/discord/callback');
    if (!cfg.enabled || !clientId || !clientSecret || !redirectUri) {
      return new NextResponse('Discord OAuth not configured', { status: 500 });
    }
    const code = request.nextUrl.searchParams.get('code');
    const stateParam = request.nextUrl.searchParams.get('state');
    const cookieNonce = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
    const state = stateParam ? await verifyOauthStateToken(stateParam) : null;
    if (!state || !cookieNonce || state.nonce !== cookieNonce) {
      return new NextResponse('Invalid OAuth state', { status: 400 });
    }
    if (!code) {
      return new NextResponse('Missing code', { status: 400 });
    }

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
       }).toString(),
     });
     if (!tokenRes.ok) {
       const errBody = await tokenRes.text();
       console.error('[DISCORD TOKEN EXCHANGE] Failed:', tokenRes.status, errBody, 'redirect_uri:', redirectUri);
       return new NextResponse('Failed to exchange token', { status: 500 });
     }
    const tokenData: any = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const userInfoRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userInfoRes.ok) {
      return new NextResponse('Failed to fetch user info', { status: 500 });
    }
    const profile: any = await userInfoRes.json();
    const discordId = profile.id as string;
    const email = profile.email as string | undefined;
    const name = profile.global_name || profile.username as string;
    const photoUrl = profile.avatar
      ? `https://cdn.discordapp.com/avatars/${discordId}/${profile.avatar}.png`
      : undefined;

    let user = await prisma.user.findUnique({ where: { discordId: discordId } });
    if (!user && email) {
      user = await prisma.user.findUnique({ where: { email } });
    }
    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: { discordId: discordId, photoUrl: user.photoUrl || photoUrl || undefined },
      });
    } else if (email) {
      user = await prisma.user.create({
        data: {
          email, name, discordId: discordId, photoUrl: photoUrl || undefined,
        },
      });
      await prisma.auditEvent.create({
        data: { actorId: user.id, action: 'user.created', targetType: 'user', targetId: user.id, metadata: { provider: 'discord', email } },
      });
    } else {
      return new NextResponse('Discord email not available', { status: 400 });
    }

    await prisma.integration.upsert({
      where: { userId_provider: { userId: user.id, provider: 'discord' } },
      update: { connected: true, metadata: { discordId, email } },
      create: { userId: user.id, provider: 'discord', connected: true, metadata: { discordId, email } },
    });

    // Link mode: user is already logged in, just record integration and redirect back
    if (state.link) {
      const existingSession = await getSession(request);
      if (existingSession) {
        await prisma.integration.upsert({
          where: { userId_provider: { userId: existingSession.userId, provider: 'discord' } },
          update: { connected: true, metadata: { discordId, email } },
          create: { userId: existingSession.userId, provider: 'discord', connected: true, metadata: { discordId, email } },
        });
        const res = NextResponse.redirect(new URL('/account/apps', request.url));
        clearOauthStateCookie(res, request);
        return res;
      }
    }

    const redirectTo = state.redirect && isAllowedRedirect(state.redirect) ? state.redirect : undefined;
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const target = oauthPostLoginTarget(user, redirectTo, 'discord');
    const res = NextResponse.redirect(target);
    setSessionCookie(res, token, refreshToken, request);
    clearOauthStateCookie(res, request);
    return res;
  } catch (err: any) {
    console.error('[DISCORD CALLBACK]', err?.message || err);
    return new NextResponse('Discord OAuth callback failed', { status: 500 });
  }
}

// Activity feed

// Workspace list

// Workspace create

export async function profileHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return new NextResponse('Unauthenticated', { status: 401 });
    }

    if (request.method === 'GET') {
      // Update lastActiveAt so user shows as "online" (fire-and-forget)
      prisma.user.update({ where: { id: session.userId }, data: { lastActiveAt: new Date() } }).catch(() => {});

      // Check in-memory cache first (avoids DB round-trip on dashboard poll)
      const cached = profileCache.get(session.userId);
      if (cached) return NextResponse.json(cached);

      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: {
          id: true,
          email: true,
          username: true,
          name: true,
          photoUrl: true,
          secondaryEmail: true,
          secondaryEmailVerified: true,
          phoneNumber: true,
          occupation: true,
          gender: true,
          birthday: true,
          bio: true,
          country: true,
          language: true,
          timezone: true,
          website: true,
          linkedin: true,
          githubUsername: true,
          twitter: true,
          companyName: true,
          companyRole: true,
          industry: true,
          companySize: true,
          adminRole: true,
          is2FAEnabled: true,
          isVerified: true,
          karmaPoints: true,
          lastLoginAt: true,
          lastLoginIp: true,
          loginCount: true,
          createdAt: true,
          updatedAt: true,
          lastActiveAt: true,
          emailVerified: true,
          phoneVerified: true,
          preferences: true,
          passwordHash: true,
          theme: true,
          dateFormat: true,
          timeFormat: true,
          isBanned: true,
          isSuspended: true,
        },
      });
      if (!user) return new NextResponse('User not found', { status: 404 });
      const { passwordHash, ...safeUser } = user as any;

      const backupCodeCount = await prisma.recoveryCode.count({ where: { userId: session.userId } });
      const result = { ...safeUser, hasPassword: !!passwordHash, hasBackupCodes: backupCodeCount > 0 };
      profileCache.set(session.userId, result);
      return NextResponse.json(result);
    }

    if (request.method === 'PATCH') {
      const body: any = await request.json();
      const schema = z.object({
        name: z.string().min(1).optional(),
        username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_.-]+$/, 'Username may only contain letters, numbers, dots, dashes and underscores.').optional().nullable(),
        photoUrl: z.string().optional().nullable(),
        secondaryEmail: z.string().email().optional(),
        phoneNumber: z.string().optional().nullable(),
        occupation: z.string().optional().nullable(),
        gender: z.string().optional().nullable(),
        birthday: z.string().optional().nullable(),
        bio: z.string().optional().nullable(),
        country: z.string().optional().nullable(),
        language: z.string().optional().nullable(),
        timezone: z.string().optional().nullable(),
        website: z.string().optional().nullable(),
        linkedIn: z.string().optional().nullable(),
        linkedin: z.string().optional().nullable(),
        github: z.string().optional().nullable(),
        twitter: z.string().optional().nullable(),
        companyName: z.string().optional().nullable(),
        companyRole: z.string().optional().nullable(),
        industry: z.string().optional().nullable(),
        companySize: z.string().optional().nullable(),
        preferences: z.record(z.string(), z.unknown()).optional(),
      });
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return new NextResponse('Invalid payload', { status: 400 });
      }
      const data: any = { ...parsed.data };
      if (data.birthday && typeof data.birthday === 'string') {
        data.birthday = new Date(data.birthday);
      }
      // Map camelCase to Prisma field names
      if ('linkedIn' in data) { data.linkedin = data.linkedIn; delete data.linkedIn; }
      if ('linkedin' in data) { data.linkedin = data.linkedin ?? null; }
      if ('github' in data) { data.githubUsername = data.github; delete data.github; }
      let updated;
      try {
        updated = await prisma.user.update({
          where: { id: session.userId },
          data,
          select: {
            id: true, email: true, username: true, name: true, photoUrl: true,
            phoneNumber: true, occupation: true, bio: true,
            website: true, linkedin: true, githubUsername: true, twitter: true,
            country: true, timezone: true, language: true,
            companyName: true, companyRole: true, industry: true, companySize: true,
            gender: true, birthday: true, secondaryEmail: true,
            preferences: true, karmaPoints: true,
            emailVerified: true, createdAt: true, updatedAt: true,
          },
        });
      } catch (err: any) {
        const meta = err?.meta || {};
        const adapterFields = meta?.driverAdapterError?.cause?.constraint?.fields;
        const targets: string[] = Array.isArray(meta?.target)
          ? meta.target
          : typeof meta?.target === 'string'
            ? [meta.target]
            : Array.isArray(adapterFields)
              ? adapterFields
              : [];
        if (err?.code === 'P2002' && targets.includes('username')) {
          return new NextResponse('That username is already taken. Please choose another one.', { status: 409 });
        }
        throw err;
      }

      prisma.auditEvent.create({
        data: {
          actorId: session.userId,
          action: 'profile.updated',
          targetType: 'user',
          targetId: session.userId,
          metadata: { fields: Object.keys(data) } as any,
          severity: 'info',
        },
      }).catch(() => {});

      bustProfileCache(session.userId);
      return NextResponse.json(updated);
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    const detail = err?.message || (err?.meta ? JSON.stringify(err.meta) : '') || String(err);
    console.error('[PROFILE]', detail);
    return new NextResponse('Failed to fetch or update profile', { status: 500 });
  }
}

// Password reset — request OTP only
// Only users with actual admin panel access (adminRole set — the same field the
// admin proxy /authorize gate checks) may use the admin reset flow. Custom
// end-user roles do NOT grant admin panel access, so they are rejected here.
export async function isAdminUser(email: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { adminRole: true },
  });
  return !!user && !!user.adminRole;
}

export async function requestPasswordResetOtpHandler(request: NextRequest) {  try {
    const { email, adminOnly } = (await request.json()) as any;
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }
    if (adminOnly) {
      const ok = await isAdminUser(email);
      if (!ok) {
        return new NextResponse('This email is not registered with admin access. Please reset your password from your account dashboard.', { status: 403 });
      }
    }
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

    if (!checkWindowLimit(`pw-reset-otp:ip:${clientIp}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many requests. Please try again later.', { status: 429 });
    }
    const result = await requestPasswordResetOtp(email);
    // Always return success to prevent email enumeration.
    // If email fails, the code is logged to console as fallback.
    return NextResponse.json({ message: 'If an account exists, a verification code has been sent.' });
  } catch (err: any) {
    console.error('[PASSWORD RESET OTP REQUEST]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

// Password reset — request magic link only
export async function requestPasswordResetMagicLinkHandler(request: NextRequest) {
  try {
    const { email } = (await request.json()) as any;
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

    if (!checkWindowLimit(`pw-reset-link:ip:${clientIp}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many requests. Please try again later.', { status: 429 });
    }
    const result = await requestPasswordResetMagicLink(email);
    // Always return success to prevent email enumeration.
    return NextResponse.json({ message: 'If an account exists, a magic link has been sent.' });
  } catch (err: any) {
    console.error('[PASSWORD RESET MAGIC LINK REQUEST]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

// Password reset — request (legacy — sends both OTP and link for backward compatibility)
export async function requestPasswordResetHandler(request: NextRequest) {
  try {
    const { email, method, adminOnly } = (await request.json()) as any;
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }
    if (adminOnly) {
      const ok = await isAdminUser(email);
      if (!ok) {
        return new NextResponse('This email is not registered with admin access. Please reset your password from your account dashboard.', { status: 403 });
      }
    }
    const resetMethod: 'otp' | 'magic_link' | 'recovery' = method === 'magic_link' ? 'magic_link' : method === 'recovery' ? 'recovery' : 'otp';
    const result =
      resetMethod === 'recovery'
        ? await requestPasswordResetRecovery(email)
        : await requestPasswordReset(email, resetMethod);
    if (!result.success && result.retryAfterMs) {
      return NextResponse.json(
        { message: 'Please wait before requesting another code.', retryAfterMs: result.retryAfterMs },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) } },
      );
    }
    // Always return success to prevent email enumeration.
    // If email fails, the resetUrl + code are logged to console as fallback.
    return NextResponse.json({ message: 'If an account exists, a reset link has been sent.' });
  } catch (err: any) {
    console.error('[PASSWORD RESET REQUEST]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

// Password reset — verify (code or token)
export async function verifyPasswordResetHandler(request: NextRequest) {
  try {
    const { email, code, token } = (await request.json()) as any;
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }
    if (!code && !token) {
      return new NextResponse('Code or token required', { status: 400 });
    }
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

    if (!checkWindowLimit(`pw-reset-verify:ip:${clientIp}`, 10, 15 * 60 * 1000)) {
      return new NextResponse('Too many attempts. Please try again later.', { status: 429 });
    }
    const result = await verifyPasswordReset(email, { code, token });
    if (!result.success) {
      return new NextResponse(result.error || 'Verification failed', { status: 400 });
    }
    return NextResponse.json({ resetToken: result.resetToken });
  } catch (err: any) {
    console.error('[PASSWORD RESET VERIFY]', err?.message || err);
    return new NextResponse('Failed to verify', { status: 500 });
  }
}

// Password reset — confirm (set new password)
export async function confirmPasswordResetHandler(request: NextRequest) {
  try {
    const body: any = await request.json();
    const resetToken = body.resetToken || body.token;
    const newPassword = body.newPassword || body.password;
    if (!resetToken || !newPassword) {
      return new NextResponse('Reset token and new password required', { status: 400 });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return new NextResponse('Password must be at least 8 characters', { status: 400 });
    }
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

    if (!checkWindowLimit(`pw-reset-confirm:ip:${clientIp}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many attempts. Please try again later.', { status: 429 });
    }
    const result = await confirmPasswordReset(resetToken, newPassword);
    if (!result.success) {
      return new NextResponse(result.error || 'Failed to reset password', { status: 400 });
    }
    return NextResponse.json({ message: 'Password updated successfully' });
  } catch (err: any) {
    console.error('[PASSWORD RESET CONFIRM]', err?.message || err);
    return new NextResponse('Failed to reset password', { status: 500 });
  }
}

// ─── Magic Link (one-time login link via email) ───

export async function requestMagicLinkHandler(request: NextRequest) {
  try {
    const { email } = (await request.json()) as any;
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

    if (!checkWindowLimit(`magic-link:ip:${clientIp}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many requests. Please try again later.', { status: 429 });
    }
    if (!checkWindowLimit(`magic-link:email:${email.toLowerCase()}`, 3, 15 * 60 * 1000)) {
      return new NextResponse('Too many requests. Please try again later.', { status: 429 });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true, name: true } });
    // Always return success to prevent email enumeration
    if (!user) {
      return NextResponse.json({ message: 'If an account exists, a magic link has been sent.' });
    }


    const token = await signMagicLinkToken(user.id);
    const callbackUrl = `${getAccountsBaseUrl()}/callback?magic_token=${token}`;

    let emailSent = false;
    try {
      const result = await sendTemplateEmail(email, 'magic_link', {
        magicLink: callbackUrl,
        name: user.name || 'there',
      });
      emailSent = result.success;
    } catch (emailErr) {
      console.error('[MAGIC LINK] Email send error:', emailErr);
    }

    const resp: any = { message: 'If an account exists, a magic link has been sent.' };
    if (!emailSent) {
      console.log(`[MAGIC LINK] Email delivery failed for ${email}`);
    }
    return NextResponse.json(resp, { status: 200 });
  } catch (err: any) {
    console.error('[MAGIC LINK REQUEST]', err?.message || err, err?.stack);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

export async function verifyMagicLinkHandler(request: NextRequest) {
  try {
    const { token } = (await request.json()) as any;
    if (!token || typeof token !== 'string') {
      return new NextResponse('Token required', { status: 400 });
    }


    const userId = await verifyMagicLinkToken(token);
    if (!userId) {
      return new NextResponse('Invalid or expired magic link', { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, isBanned: true, isSuspended: true, emailVerified: true } });
    if (!user) {
      return new NextResponse('User not found', { status: 404 });
    }
    if (user.isBanned || user.isSuspended) {
      return new NextResponse('Account suspended', { status: 403 });
    }
    if (!user.emailVerified) {
      return new NextResponse('Please verify your email before signing in', { status: 403 });
    }

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const { token: sessionToken, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.json({ email: user.email, token: sessionToken });
    setSessionCookie(res, sessionToken, refreshToken, request);

    await createAuditEvent({
      actorId: user.id,
      action: 'user.login',
      targetType: 'user',
      targetId: user.id,
      metadata: { method: 'magic_link', ip },
    });

    return res;
  } catch (err: any) {
    console.error('[MAGIC LINK VERIFY]', err?.message || err);
    return new NextResponse('Magic link verification failed', { status: 500 });
  }
}

// ─── Workspace Delete (user-facing) ───



// ─── Account Recovery ───────────────────────────────────────

export async function accountRecoveryHandler(request: NextRequest) {
  try {
    const { email } = (await request.json()) as any;
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Always return success to prevent email enumeration
    if (!user) {
      return NextResponse.json({ message: 'If an account exists, recovery instructions have been sent.' });
    }

    const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
    // The standalone /recovery page was removed (accounts app is auth-only now);
    // point users at /forgot-password which has the full OTP/magic-link reset flow.
    const recoveryUrl = `https://accounts.${appDomain}/forgot-password`;

    await sendTemplateEmail(email, 'account_recovery', {
      recoveryUrl,
      name: user.name || 'there',
    }).catch(err => console.error('[ACCOUNT RECOVERY] Email send error:', err));

    return NextResponse.json({ message: 'If an account exists, recovery instructions have been sent.' });
  } catch (err: any) {
    console.error('[ACCOUNT RECOVERY]', err?.message || err);
    return new NextResponse('Failed to process request', { status: 500 });
  }
}

// ─── Recovery Email Login ───────────────────────────────────
// Sign in using a verified recovery (secondary) email. A code is sent to the
// recovery email and, once verified, the user is logged into their primary
// account (chained through 2FA when enabled).

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const keep = Math.min(local.length, 2);
  return `${local.slice(0, keep)}${'*'.repeat(Math.max(local.length - keep, 1))}@${domain}`;
}

export async function recoveryLoginRequestHandler(request: NextRequest) {
  try {
    const { email } = (await request.json()) as any;
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

    if (!checkWindowLimit(`recovery-login:ip:${clientIp}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many requests. Please try again later.', { status: 429 });
    }
    if (!checkWindowLimit(`recovery-login:email:${email.toLowerCase()}`, 3, 15 * 60 * 1000)) {
      return new NextResponse('Too many requests. Please try again later.', { status: 429 });
    }

    const cooldown = enforceResendCooldown(`recovery-login:${email.toLowerCase()}`);
    if (!cooldown.allowed) {
      return NextResponse.json(
        { message: 'Please wait before requesting another code.', retryAfterMs: cooldown.remainingMs },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(cooldown.remainingMs / 1000)) } },
      );
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true, secondaryEmail: true, isBanned: true, isSuspended: true },
    });
    if (!user || !user.secondaryEmail) {
      return new NextResponse('No verified recovery email is set for this account', { status: 400 });
    }
    if (user.isBanned || user.isSuspended) {
      return new NextResponse('Account suspended', { status: 403 });
    }

    const code = generateOtpCode();
    await storeOtp(user.id, 'email', code);
    try {
      const result = await sendSignupOtpEmail(user.secondaryEmail, code, 'login_otp');
      if (!result.success) {
        console.error('[RECOVERY LOGIN] Email send returned failure');
        return new NextResponse('Could not send a code to your recovery email. Try again later.', { status: 502 });
      }
    } catch (err: any) {
      console.error('[RECOVERY LOGIN] Email send error:', err?.message || err);
      return new NextResponse('Could not send a code to your recovery email. Try again later.', { status: 502 });
    }

    return NextResponse.json({ ok: true, masked: maskEmail(user.secondaryEmail) });
  } catch (err: any) {
    console.error('[RECOVERY LOGIN REQUEST]', err?.message || err);
    return new NextResponse('Failed to send recovery code', { status: 500 });
  }
}

export async function recoveryLoginVerifyHandler(request: NextRequest) {
  try {
    const { email, code } = (await request.json()) as any;
    if (!email || typeof email !== 'string' || !code || typeof code !== 'string') {
      return new NextResponse('Email and code are required', { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true, isBanned: true, isSuspended: true, emailVerified: true, is2FAEnabled: true },
    });
    if (!user) return new NextResponse('Invalid email or code', { status: 401 });
    if (user.isBanned || user.isSuspended) return new NextResponse('Account suspended', { status: 403 });
    if (!user.emailVerified) return new NextResponse('Please verify your email before signing in', { status: 403 });

    const ok = await verifyOtpCode(user.id, 'email', code);
    if (!ok) {
      return new NextResponse('Invalid or expired verification code', { status: 400 });
    }

    if (user.is2FAEnabled) {
      const tempToken = await signTemp2faToken(user.id);
      return NextResponse.json({ requiresMfa: true, tempToken });
    }

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.json({ id: user.id, email: user.email, token });
    setSessionCookie(res, token, refreshToken, request);

    logSecurityEvent({ request, userId: user.id, eventType: 'auth.login_recovery_email_success' }).catch(() => {});
    return res;
  } catch (err: any) {
    console.error('[RECOVERY LOGIN VERIFY]', err?.message || err);
    return new NextResponse('Verification failed', { status: 500 });
  }
}

// ─── Suspicious Login ───────────────────────────────────────

export async function suspiciousLoginConfirmHandler(request: NextRequest) {
  try {
    const { token } = (await request.json()) as any;
    if (!token || typeof token !== 'string') {
      return new NextResponse('Invalid token', { status: 400 });
    }

    const userId = await verifySuspiciousLoginToken(token);
    if (!userId) {
      return new NextResponse('Invalid or expired token', { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, isBanned: true, isSuspended: true },
    });
    if (!user) {
      return new NextResponse('User not found', { status: 404 });
    }
    if (user.isBanned || user.isSuspended) {
      return new NextResponse('Account suspended', { status: 403 });
    }

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const { token: sessionToken, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.json({ id: user.id, email: user.email, token: sessionToken });
    setSessionCookie(res, sessionToken, refreshToken, request);
    return res;
  } catch {
    return new NextResponse('Failed to confirm suspicious login', { status: 400 });
  }
}

export async function suspiciousLoginDenyHandler(request: NextRequest) {
  try {
    const { token } = (await request.json()) as any;
    if (!token || typeof token !== 'string') {
      return new NextResponse('Invalid token', { status: 400 });
    }

    // Log the denied attempt
    const userId = await verifySuspiciousLoginToken(token);
    if (userId) {
      await createAuditEvent({
        actorId: userId,
        action: 'suspicious_login.denied',
        targetType: 'user',
        targetId: userId,
        severity: 'warning',
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true });
  } catch {
    return new NextResponse('Failed to deny suspicious login', { status: 400 });
  }
}

// ─── Verify (legacy email OTP verification) ──────────────────

export async function verifyHandler(request: NextRequest) {
  // Deprecated — use auth/verify-email instead. Never issue sessions from this path.
  return new NextResponse('Not implemented', { status: 501 });
}

// ─── Public Help Config ───

const DEFAULT_HELP_ARTICLES = [
  { id: "1", title: "Getting Started with Tirbeo", content: "Welcome to Tirbeo! This guide will help you set up your account, configure your profile, and explore the platform.", category: "Getting Started", icon: "zap" },
  { id: "2", title: "How to Change Your Password", content: "Go to Security → Change Password. Enter your current password, then your new password (minimum 8 characters).", category: "Security", icon: "shield" },
  { id: "3", title: "Setting Up Two-Factor Authentication", content: "Navigate to Security → Two-Factor Authentication. You can use an authenticator app or SMS verification.", category: "Security", icon: "shield" },
  { id: "4", title: "Managing Your Notifications", content: "Go to Preferences → Notifications to configure what alerts you receive.", category: "Account", icon: "bell" },
  { id: "5", title: "Customizing Your Dashboard", content: "Open Preferences to personalize your experience. Change themes, adjust fonts, modify colors.", category: "Account", icon: "settings" },
  { id: "6", title: "Connecting Third-Party Accounts", content: "Visit Integrations to connect Google, GitHub, and other services.", category: "Account", icon: "link" },
  { id: "7", title: "Understanding Your Activity Log", content: "The Activity page shows a complete history of everything that happened on your account.", category: "Account", icon: "activity" },
  { id: "8", title: "Managing Active Sessions", content: "In Security → Active Sessions, you can see all devices currently signed into your account.", category: "Security", icon: "shield" },
  { id: "9", title: "Recovery Options", content: "Set up recovery email and phone in Security → Recovery Options.", category: "Security", icon: "shield" },
  { id: "10", title: "Backup Codes", content: "In Security → Backup Codes, you can generate one-time codes for emergency access.", category: "Security", icon: "shield" },
  { id: "11", title: "Reporting a Bug", content: "Found a bug? Report it through our GitHub issues page or contact support directly.", category: "Support", icon: "bug" },
  { id: "12", title: "Privacy & Data", content: "Your privacy matters. You can export all your data from Preferences → Data & Privacy.", category: "Account", icon: "globe" },
  { id: "13", title: "How to Create a Form", content: "Navigate to Forms → Create Form. Choose a template or start from scratch, add fields, and publish.", category: "Forms", icon: "book" },
  { id: "14", title: "Form Field Types", content: "Tirbeo supports text, email, number, dropdown, radio, checkbox, file upload, rating, and more.", category: "Forms", icon: "book" },
  { id: "15", title: "Sharing Your Form", content: "Use the Share button to get a link, embed code, or QR code. You can also set visibility to public or private.", category: "Forms", icon: "link" },
  { id: "16", title: "Viewing Form Responses", content: "Go to Forms → Responses to see all submissions. You can filter by date, export to CSV, or view individual responses.", category: "Forms", icon: "activity" },
  { id: "17", title: "Form Analytics", content: "The Analytics tab shows completion rates, drop-off points, device breakdown, and geographic data.", category: "Forms", icon: "activity" },
  { id: "18", title: "Form Security Settings", content: "Enable CAPTCHA, set response limits, require login, or add expiration dates in Form Settings → Security.", category: "Forms", icon: "shield" },
  { id: "19", title: "Collaborating on Forms", content: "Invite team members via Settings → Collaborators. They can edit or view based on permissions.", category: "Forms", icon: "link" },
  { id: "20", title: "Form Templates", content: "Browse pre-built templates in the Templates gallery. Customize any template to match your brand.", category: "Forms", icon: "book" },
  { id: "21", title: "Managing Your Subscription", content: "View your plan, usage, and billing history in Settings → Billing. Upgrade or downgrade anytime.", category: "Billing", icon: "settings" },
  { id: "22", title: "Payment Methods", content: "Add or update payment cards in Settings → Billing → Payment Methods. We accept Visa, Mastercard, and Amex.", category: "Billing", icon: "globe" },
  { id: "23", title: "Invoice & Receipts", content: "Download invoices from Settings → Billing → Invoices. They are also emailed after each payment.", category: "Billing", icon: "book" },
  { id: "24", title: "Cancel Subscription", content: "Go to Settings → Billing → Cancel Plan. Your access continues until the end of the billing period.", category: "Billing", icon: "settings" },
  { id: "25", title: "API Keys", content: "Generate API keys in Settings → API. Keys are shown once; store them securely. Rotate keys regularly.", category: "Integrations", icon: "link" },
  { id: "26", title: "Webhooks", content: "Configure webhooks in Settings → Integrations to receive real-time events for forms, tickets, and users.", category: "Integrations", icon: "link" },
  { id: "27", title: "SSO & SAML", content: "Enterprise plans support SAML 2.0 SSO. Configure in Settings → Security → Single Sign-On.", category: "Integrations", icon: "shield" },
  { id: "28", title: "Zapier Integration", content: "Connect Tirbeo to 5,000+ apps via Zapier. Find Tirbeo in the Zapier app directory.", category: "Integrations", icon: "link" },
  { id: "29", title: "Custom Domains", content: "Add a custom domain in Settings → Domains. Update your DNS CNAME to point to Tirbeo.", category: "Account", icon: "globe" },
  { id: "30", title: "Team Roles & Permissions", content: "Manage roles in Settings → Roles. Assign admin, editor, or viewer access to team members.", category: "Account", icon: "shield" },
  { id: "31", title: "Organization Settings", content: "Configure workspace name, logo, and default settings in Settings → Organization.", category: "Account", icon: "settings" },
  { id: "32", title: "Data Export", content: "Export all your data as JSON or CSV from Settings → Data & Privacy → Export.", category: "Account", icon: "activity" },
  { id: "33", title: "Account Deletion", content: "Permanently delete your account in Settings → Account → Delete Account. This action cannot be undone.", category: "Account", icon: "shield" },
  { id: "34", title: "Email Configuration", content: "Set up custom email providers, DKIM, and sending domains in Settings → Email.", category: "Account", icon: "bell" },
  { id: "35", title: "Rate Limits", content: "Free plans have API rate limits. View current usage in Settings → API → Rate Limits.", category: "Account", icon: "activity" },
  { id: "36", title: "Troubleshooting Login Issues", content: "Clear cookies, disable VPN, or use incognito mode. If issues persist, contact support.", category: "Troubleshooting", icon: "bug" },
  { id: "37", title: "Form Not Publishing", content: "Check that all required fields are filled and your plan allows form publishing.", category: "Troubleshooting", icon: "bug" },
  { id: "38", title: "Emails Not Sending", content: "Verify your email configuration in Settings → Email. Check spam folders and sender reputation.", category: "Troubleshooting", icon: "bug" },
  { id: "39", title: "Slow Dashboard Performance", content: "Try disabling browser extensions, clearing cache, or switching to a supported browser.", category: "Troubleshooting", icon: "bug" },
  { id: "40", title: "Mobile App Support", content: "Tirbeo is fully responsive on mobile browsers, so you can create forms and review responses on any device.", category: "Troubleshooting", icon: "bug" },
  { id: "41", title: "Browser Compatibility", content: "We support Chrome, Firefox, Safari, and Edge (latest 2 versions). IE is not supported.", category: "Troubleshooting", icon: "bug" },
  { id: "42", title: "Contacting Support", content: "Email support@tirbeo.app or use the Contact Us page. Premium users get priority support.", category: "Support", icon: "lifebuoy" },
  { id: "43", title: "Support Response Times", content: "Free: 48 hours, Pro: 24 hours, Enterprise: 4 hours. Check status at support.tirbeo.app.", category: "Support", icon: "lifebuoy" },
  { id: "44", title: "Feature Requests", content: "Submit feature requests via the Feedback button in-app or email ideas@tirbeo.app.", category: "Support", icon: "lifebuoy" },
  { id: "45", title: "Service Status", content: "Check real-time status at status.tirbeo.app. Subscribe to updates for incident notifications.", category: "Support", icon: "lifebuoy" },
  { id: "46", title: "Community Forum", content: "Join discussions, share tips, and connect with other users at community.tirbeo.app.", category: "Support", icon: "lifebuoy" },
  { id: "47", title: "Video Tutorials", content: "Watch step-by-step guides on our YouTube channel at youtube.com/@tirbeo.", category: "Getting Started", icon: "zap" },
  { id: "48", title: "Onboarding Walkthrough", content: "New users see an interactive tour on first login. Replay it from Settings → Help → Tour.", category: "Getting Started", icon: "zap" },
  { id: "49", title: "Keyboard Shortcuts", content: "Press Cmd/Ctrl + K for command palette. See all shortcuts in Help → Keyboard Shortcuts.", category: "Getting Started", icon: "zap" },
  { id: "50", title: "Dark Mode", content: "Toggle dark mode from the user menu or Settings → Theme. Your preference syncs across devices.", category: "Account", icon: "settings" },
  { id: "51", title: "Language & Region", content: "Change language in Settings → Preferences. We support English, Spanish, French, and German.", category: "Account", icon: "globe" },
  { id: "52", title: "Accessibility", content: "Tirbeo follows WCAG 2.1 AA standards. Report accessibility issues to a11y@tirbeo.app.", category: "Account", icon: "globe" },
  { id: "53", title: "GDPR Compliance", content: "We are GDPR compliant. Request data deletion or export from Settings → Privacy.", category: "Security", icon: "shield" },
  { id: "54", title: "SOC 2 Certification", content: "Tirbeo is SOC 2 Type II certified. View our security whitepaper at tirbeo.app/security.", category: "Security", icon: "shield" },
  { id: "55", title: "Data Residency", content: "Choose your data region in Settings → Privacy → Data Residency. Available: US, EU, APAC.", category: "Security", icon: "globe" },
  { id: "56", title: "OAuth Apps", content: "Manage connected OAuth apps in Settings → Security → Connected Apps. Revoke access anytime.", category: "Security", icon: "shield" },
  { id: "57", title: "Passkeys", content: "Set up passkeys for passwordless login in Settings → Security → Passkeys.", category: "Security", icon: "shield" },
  { id: "58", title: "Audit Logs", content: "View detailed audit logs in Admin → Security → Audit. Enterprise plans retain logs for 1 year.", category: "Security", icon: "activity" },
  { id: "59", title: "IP Allowlisting", content: "Restrict access to specific IPs in Settings → Security → IP Allowlist.", category: "Security", icon: "shield" },
  { id: "60", title: "Custom SMTP", content: "Configure custom SMTP in Settings → Email → SMTP. Supports SendGrid, Mailgun, AWS SES.", category: "Integrations", icon: "link" },
];

export async function helpConfigHandler(request: NextRequest) {
  try {
    const dbArticles = await prisma.helpArticle.findMany({
      where: { published: true },
      orderBy: [{ ord: 'asc' }, { title: 'asc' }],
      select: { id: true, title: true, content: true, category: true, icon: true },
    });

    if (dbArticles.length > 0) {
      // Merge: DB articles override the in-code defaults by title, and any
      // new articles are appended. This way adding a doc in the support app
      // never wipes out the built-in article set.
      const byTitle = new Map(dbArticles.map((a) => [a.title.toLowerCase(), a]));
      const merged = DEFAULT_HELP_ARTICLES.map((def) => byTitle.get(def.title.toLowerCase()) || def);
      for (const db of dbArticles) {
        if (!merged.some((m) => m.title.toLowerCase() === db.title.toLowerCase())) {
          merged.push(db);
        }
      }
      return NextResponse.json({
        articles: merged,
        contactEmail: "support@tirbeo.app",
        faqEnabled: true,
        syncedFromDb: true,
      });
    }
  } catch (err: any) {
    console.error('[HELP CONFIG] DB fallback', err?.message || err);
  }

  // Fallback: in-code defaults when no published articles exist in the DB yet.
  return NextResponse.json({
    articles: DEFAULT_HELP_ARTICLES,
    contactEmail: "support@tirbeo.app",
    faqEnabled: true,
    syncedFromDb: false,
  });
}

export async function faqHandler(request: NextRequest) {
  const category = request.nextUrl.searchParams.get('category') || '';
  const search = request.nextUrl.searchParams.get('search') || '';
  const help = await helpConfigHandler(request);
  const articles = (await help.json() as any).articles;
  let filtered = articles;
  if (category) filtered = filtered.filter(a => a.category === category);
  if (search) filtered = filtered.filter(a => a.title.toLowerCase().includes(search.toLowerCase()) || a.content.toLowerCase().includes(search.toLowerCase()));
  const categories = Array.from(new Set(articles.map(a => a.category)));
  return NextResponse.json({ articles: filtered, categories });
}

export async function cliTokenHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return new NextResponse('Not authenticated', { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, name: true, isBanned: true, isSuspended: true },
    });
    if (!user) return new NextResponse('User not found', { status: 404 });
    if (user.isBanned || user.isSuspended) {
      return new NextResponse('Account suspended', { status: 403 });
    }

    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const cliToken = await new SignJWT({ sub: user.id, purpose: 'cli' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(secret);

    await createAuditEvent({
      actorId: user.id,
      action: 'CLI_LOGIN',
      targetType: 'session',
      targetId: cliToken.slice(0, 16),
      metadata: { userAgent: request.headers.get('user-agent') },
    });

    return NextResponse.json({
      token: cliToken,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err: any) {
    console.error('[CLI-TOKEN]', err?.message || err);
    return new NextResponse('Failed to generate CLI token', { status: 500 });
  }
}

// ─── Waitlist ───────────────────────────────────────────────


// ─── Feedback ───────────────────────────────────────────────


// ─── Admin: Subscribers ─────────────────────────────────────


// ─── Admin: Feedback ────────────────────────────────────────


// ─── Chat (OpenRouter LLM proxy for landing demo) ────────────

const ALLOWED_CHAT_MODELS = new Set([
  'tencent/hy3:free',
  'google/gemini-2.0-flash-exp:free',
  'meta-llama/llama-4-maverick:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
]);

const chatRateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkChatRateLimit(ip: string, maxRequests = 20, windowMs = 60000): boolean {
  const now = Date.now();
  const entry = chatRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    chatRateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count++;
  return true;
}

export async function chatHandler(request: NextRequest) {
  try {
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!checkChatRateLimit(clientIp)) {
      return NextResponse.json({ error: 'Rate limit exceeded. Please try again later.' }, { status: 429 });
    }

    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      return NextResponse.json({ error: 'OPENROUTER_API_KEY not set' }, { status: 500 });
    }

    const body: any = await request.json().catch(() => ({}));
    const model = body.model || 'tencent/hy3:free';
    if (!ALLOWED_CHAT_MODELS.has(model)) {
      return NextResponse.json(
        { error: `Model "${model}" is not allowed. Allowed models: ${[...ALLOWED_CHAT_MODELS].join(', ')}` },
        { status: 400 }
      );
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length > 50) {
      return NextResponse.json({ error: 'Maximum 50 messages allowed per request' }, { status: 400 });
    }
    const sanitizedMessages = messages.map((m: any) => {
      if (!m || typeof m.content !== 'string') return null;
      return {
        role: ['user', 'assistant', 'system'].includes(m.role) ? m.role : 'user',
        content: m.content.slice(0, 10000),
      };
    }).filter(Boolean);
    if (sanitizedMessages.length === 0) {
      return NextResponse.json({ error: 'No valid messages provided' }, { status: 400 });
    }

    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://tirbeo.app',
        'X-Title': 'Tirbeo',
      },
      body: JSON.stringify({
        model,
        messages: sanitizedMessages,
        temperature: 0.7,
        max_tokens: 2048,
      }),
    });
    const data = await upstream.text();
    return new NextResponse(data, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[CHAT]', err?.message || err);
    return NextResponse.json({ error: err?.message || 'proxy error' }, { status: 500 });
  }
}
