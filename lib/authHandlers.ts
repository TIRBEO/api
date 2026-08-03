import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from './db/prisma';
import { generateOtpCode, storeOtp, verifyOtpCode, sendEmailOtp, sendPhoneOtp } from './auth/otp';
import { generateOtpCode as genSignupOtp, storeSignupOtp, verifySignupOtp, sendSignupOtpEmail } from './auth/signup-otp';
import { hashPassword, verifyPassword } from './auth/password';
import { createSession, setSessionCookie, clearSessionCookie, revokeSession, rotateRefreshToken, REFRESH_COOKIE_NAME, COOKIE_DOMAIN } from './auth/session';
import { getSession, requireAdmin } from './session';
import { signTemp2faToken, verifyTemp2faToken, signMagicLinkToken, verifyMagicLinkToken, signOauthStateToken, verifyOauthStateToken, signRecoveryToken, verifyRecoveryToken, signSuspiciousLoginToken, verifySuspiciousLoginToken, signSessionRevokeToken, verifySessionRevokeToken } from './auth/jwt';
import { verifyTotp } from './auth/totp';
import { sendTemplateEmail } from './email';
import { sanitizeInput } from './security';
import { requestPasswordReset, requestPasswordResetOtp, requestPasswordResetMagicLink, verifyPasswordReset, confirmPasswordReset } from './auth/password-reset';
import { createAuditEvent } from './audit';
import { enforceResendCooldown } from './auth/resend-cooldown';
import { checkPasswordBreach } from './auth/breach';
import { jsonUnauthorized } from './response';

export async function sessionHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, name: true, photoUrl: true, is2FAEnabled: true, adminRole: true, roles: { include: { role: true } }, emailVerified: true, preferences: true },
    });
    if (!user) return jsonUnauthorized();
    const adminRole = user.adminRole || user.roles?.[0]?.role?.name;
    return NextResponse.json({ user: { id: user.id, email: user.email, name: user.name, photoUrl: user.photoUrl, is2FAEnabled: user.is2FAEnabled, adminRole, emailVerified: user.emailVerified, preferences: user.preferences } });
  } catch (err: any) {
    console.error('[SESSION]', err?.message || err);
    return new NextResponse('Failed to fetch session', { status: 500 });
  }
}

export async function refreshHandler(request: NextRequest) {
  try {
    const refreshToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value;
    if (!refreshToken) {
      const res = new NextResponse('Refresh token missing', { status: 401 });
      clearSessionCookie(res);
      return res;
    }
    const result = await rotateRefreshToken(refreshToken, getIp(request), request.headers.get('user-agent') || undefined);
    if (!result) {
      const res = new NextResponse('Session expired', { status: 401 });
      clearSessionCookie(res);
      return res;
    }
    const res = NextResponse.json({ token: result.token, sessionId: result.sessionId });
    setSessionCookie(res, result.token, result.refreshToken);
    return res;
  } catch (err: any) {
    console.error('[REFRESH]', err?.message || err);
    const res = new NextResponse('Refresh failed', { status: 500 });
    clearSessionCookie(res);
    return res;
  }
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
  return `${protocol}://${host}${path}`;
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

async function getOauthProviderConfig(provider: string): Promise<OauthProviderConfig> {
  const keys = OAUTH_ENV_KEYS[provider];
  let configured: any = {};
  try {
    const record = await prisma.siteConfig.findUnique({ where: { app: 'accounts' } });
    const cfgJson: any = record?.config || {};
    configured = cfgJson?.oauth?.[provider] || {};
  } catch {}
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
  fingerprint: z.string().optional(),
});

export async function loginHandler(request: NextRequest) {
  try {
    const parsed = loginSchema.safeParse(await request.json());
    if (!parsed.success) {
      return new NextResponse('Invalid email or password', { status: 400 });
    }
    const { email, password, captchaRayId, fingerprint } = parsed.data;

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || '';
    const captchaSession = request.cookies.get('__captcha_session')?.value || 'anonymous';
    const sessionId = captchaSession;

    const { checkWindowLimit } = await import('./captcha/risk');
    if (!checkWindowLimit(`login:email:${email.toLowerCase()}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many sign-in attempts. Please try again later.', { status: 429 });
    }
    if (!checkWindowLimit(`login:ip:${ip}`, 20, 15 * 60 * 1000)) {
      return new NextResponse('Too many sign-in attempts. Please try again later.', { status: 429 });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true, email: true, passwordHash: true, is2FAEnabled: true, isBanned: true, isSuspended: true, adminRole: true, roles: { include: { role: true } } } });
    if (!user) {
      const { logSecurityEvent } = await import('./security');
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
    const { getUserWarningCount, getRequiredDifficulty, assertCaptchaSatisfied } = await import('./captcha/service');
    const warnings = await getUserWarningCount(user.id, ip);
    const forceCaptcha = warnings.recentBlocks > 0 || warnings.count >= 2;
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
      const { logSecurityEvent } = await import('./security');
      const { recordRateLimitHit } = await import('./auth/suspicious-activity');
      recordRateLimitHit(ip);
      logSecurityEvent({ request, userId: user.id, eventType: 'auth.login_failed', details: { reason: 'wrong_password' } }).catch(() => {});
      return new NextResponse('Invalid email or password', { status: 401 });
    }

    const captchaSettings = (await import('./captcha/service')).getCaptchaSettings;
    const settings = await captchaSettings();

    if (settings.enabled) {
      const { computeRiskScore } = await import('./captcha/risk');
      const { getRequiredDifficulty, assertCaptchaSatisfied } = await import('./captcha/service');
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

    const adminRole = user.adminRole || user.roles?.[0]?.role?.name;
    const { token, refreshToken, sessionId: newSessionId } = await createSession(user.id, userAgent || undefined, ip, adminRole);
    const res = NextResponse.json({ id: user.id, email: user.email, token });
    setSessionCookie(res, token, refreshToken);

    const { recordDeviceSeen } = await import('./captcha/risk');
    recordDeviceSeen({ fingerprint, userId: user.id, ip, ua: userAgent, sessionId }).catch(() => {});

    const lastSession = await prisma.session.findFirst({
      where: { userId: user.id, id: { not: newSessionId }, status: { not: 'revoked' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, ipAddress: true },
    });

    const isNewIp = !lastSession || lastSession.ipAddress !== ip;
    if (isNewIp) {
      const revokeToken = await signSessionRevokeToken(newSessionId);
      const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
      sendTemplateEmail(user.email, 'login_alert', {
        name: user.email.split('@')[0],
        location: 'Unknown',
        device: userAgent || 'Unknown device',
        loginTime: new Date().toLocaleString(),
        revokeUrl: `https://accounts.${appDomain}/session/revoke?t=${revokeToken}`,
      }).catch(() => {});
    }

    return res;
  } catch (err: any) {
    console.error('[LOGIN]', err?.message || err);
    return new NextResponse('Login failed', { status: 400 });
  }
}

export async function adminLoginHandler(request: NextRequest) {
  try {
    const parsed = loginSchema.safeParse(await request.json());
    if (!parsed.success) {
      return new NextResponse('Invalid email or password', { status: 400 });
    }
    const { email, password, captchaRayId, fingerprint } = parsed.data;

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || '';
    const captchaSession = request.cookies.get('__captcha_session')?.value || 'anonymous';
    const sessionId = captchaSession;

    const { checkWindowLimit } = await import('./captcha/risk');
    if (!checkWindowLimit(`admin:login:email:${email.toLowerCase()}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many sign-in attempts. Please try again later.', { status: 429 });
    }
    if (!checkWindowLimit(`admin:login:ip:${ip}`, 20, 15 * 60 * 1000)) {
      return new NextResponse('Too many sign-in attempts. Please try again later.', { status: 429 });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true, passwordHash: true, is2FAEnabled: true, isBanned: true, isSuspended: true, adminRole: true, roles: { include: { role: true } } },
    });
    if (!user) {
      const { logSecurityEvent } = await import('./security');
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
    const { getUserWarningCount, getRequiredDifficulty, assertCaptchaSatisfied } = await import('./captcha/service');
    const warnings = await getUserWarningCount(user.id, ip);
    const forceCaptcha = warnings.recentBlocks > 0 || warnings.count >= 2;
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
      const { logSecurityEvent } = await import('./security');
      const { recordRateLimitHit } = await import('./auth/suspicious-activity');
      recordRateLimitHit(ip);
      logSecurityEvent({ request, userId: user.id, eventType: 'auth.admin_login_failed', details: { reason: 'wrong_password' } }).catch(() => {});
      return new NextResponse('Invalid email or password', { status: 401 });
    }

    if (!user.adminRole && !user.roles?.[0]?.role) {
      const { logSecurityEvent } = await import('./security');
      logSecurityEvent({ request, userId: user.id, eventType: 'auth.admin_login_failed', details: { reason: 'not_admin' } }).catch(() => {});
      sendTemplateEmail(user.email, 'admin_alert', {
        subject: 'Unauthorized Admin Access Attempt',
        message: 'A user without admin privileges attempted to access the admin panel.',
        details: `<p>Email: ${user.email}</p><p>Time: ${new Date().toLocaleString()}</p>`,
        dashboardUrl: 'https://admin.tirbeo.app',
      }).catch(() => {});
      return new NextResponse('Access denied. You do not have admin privileges.', { status: 403 });
    }

    const captchaSettings = (await import('./captcha/service')).getCaptchaSettings;
    const settings = await captchaSettings();

    if (settings.enabled) {
      const { computeRiskScore } = await import('./captcha/risk');
      const { getRequiredDifficulty, assertCaptchaSatisfied } = await import('./captcha/service');
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

    const adminRole = user.adminRole || user.roles?.[0]?.role?.name;
    const { token, refreshToken, sessionId: newSessionId } = await createSession(user.id, userAgent || undefined, ip, adminRole);
    const res = NextResponse.json({ id: user.id, email: user.email, token });
    setSessionCookie(res, token, refreshToken);

    const { recordDeviceSeen } = await import('./captcha/risk');
    recordDeviceSeen({ fingerprint, userId: user.id, ip, ua: userAgent, sessionId }).catch(() => {});

    const lastSession = await prisma.session.findFirst({
      where: { userId: user.id, id: { not: newSessionId }, status: { not: 'revoked' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, ipAddress: true },
    });

    const isNewIp = !lastSession || lastSession.ipAddress !== ip;
    if (isNewIp) {
      const revokeToken = await signSessionRevokeToken(newSessionId);
      const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
      sendTemplateEmail(user.email, 'login_alert', {
        name: user.email.split('@')[0],
        location: 'Admin Panel',
        device: userAgent || 'Unknown device',
        loginTime: new Date().toLocaleString(),
        revokeUrl: `https://accounts.${appDomain}/session/revoke?t=${revokeToken}`,
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
    const { tempToken, token: totpCode } = await request.json();
    if (typeof tempToken !== 'string' || typeof totpCode !== 'string') {
      return new NextResponse('Invalid payload', { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
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
      const { logSecurityEvent } = await import('./security');
      logSecurityEvent({ request, userId, eventType: 'auth.2fa_failed', details: { reason: 'invalid_code' } }).catch(() => {});
      return new NextResponse('Invalid 2FA code', { status: 401 });
    }

    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, clientIp);
    const res = NextResponse.json({ id: user.id, email: user.email, token });
    setSessionCookie(res, token, refreshToken);
    return res;
  } catch {
    return new NextResponse('2FA verification failed', { status: 400 });
  }
}

export async function recovery2faLoginHandler(request: NextRequest) {
  try {
    const { tempToken, recoveryCode } = await request.json();
    if (typeof tempToken !== 'string' || typeof recoveryCode !== 'string') {
      return new NextResponse('Invalid payload', { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
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
    const { hashRecoveryCode, normalizeRecoveryCode } = await import('./auth/password');
    const inputHash = hashRecoveryCode(recoveryCode);
    const inputNorm = normalizeRecoveryCode(recoveryCode);
    const rc = codes.find(c => c.code === inputHash || c.code === inputNorm) || null;
    if (!rc) return new NextResponse('Invalid recovery code', { status: 401 });

    if (rc.code !== inputHash) {
      await prisma.recoveryCode.update({
        where: { id: rc.id },
        data: { code: inputHash },
      });
    }

    await prisma.recoveryCode.update({
      where: { id: rc.id },
      data: { used: true, usedAt: new Date() },
    });

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.json({ id: user.id, email: user.email, token });
    setSessionCookie(res, token, refreshToken);
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
  username: z.string().min(3).optional().or(z.literal('')),
  dob: z.string().optional(),
  gender: z.string().optional(),
  photoUrl: z.string().url().optional().or(z.literal('')),
  occupation: z.string().min(1),
  companyName: z.string().optional().or(z.literal('')),
  policyAccepted: z.boolean(),
  adminDataAccess: z.boolean().optional(),
  signatureDataUrl: z.string().min(20),
  signatureName: z.string().min(1),
  turnstileToken: z.string().optional(),
  captchaRayId: z.string().optional(),
  fingerprint: z.string().optional(),
});

export async function emailExistsHandler(request: NextRequest) {
  try {
    const body = await request.json();
    const email = (body?.email || '').toString().toLowerCase().trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ exists: false, hasPassword: false }, { status: 200 });
    }
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true },
    });
    return NextResponse.json({
      exists: !!user,
      hasPassword: !!user?.passwordHash,
    }, { status: 200 });
  } catch (err: any) {
    console.error('[EMAIL-EXISTS]', err?.message || err);
    return NextResponse.json({ error: 'Could not check email' }, { status: 500 });
  }
}

export async function signupHandler(request: NextRequest) {
  try {
    const parsed = signupSchema.safeParse(await request.json());
    if (!parsed.success) {
      return new NextResponse('Invalid request payload', { status: 400 });
    }
    const { email, password, firstName, lastName, username, dob, gender, photoUrl, occupation, companyName, policyAccepted, adminDataAccess, signatureDataUrl, signatureName, captchaRayId, fingerprint } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedUsername = username ? username.toString().trim().toLowerCase() : undefined;
    const normalizedPhotoUrl = photoUrl ? photoUrl.toString().trim() : undefined;
    const normalizedCompanyName = companyName ? companyName.toString().trim() : undefined;
    const normalizedOccupation = sanitizeInput(occupation, 120).trim();
    const normalizedSignatureName = sanitizeInput(signatureName, 200).trim();

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || '';
    const captchaSession = request.cookies.get('__captcha_session')?.value || 'anonymous';

    if (!policyAccepted) {
      return new NextResponse('Policy acceptance is required', { status: 400 });
    }
    if (!normalizedOccupation) {
      return new NextResponse('Occupation is required', { status: 400 });
    }
    if (!signatureDataUrl || !normalizedSignatureName) {
      return new NextResponse('Signature is required', { status: 400 });
    }

    const { checkWindowLimit } = await import('./captcha/risk');
    if (!checkWindowLimit(`signup:ip:${ip}`, 10, 60 * 60 * 1000)) {
      return new NextResponse('Too many sign-up attempts. Please try again later.', { status: 429 });
    }
    if (!checkWindowLimit(`signup:email:${email.toLowerCase()}`, 3, 60 * 60 * 1000)) {
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

    const captchaSettings = (await import('./captcha/service')).getCaptchaSettings;
    const settings = await captchaSettings();
    if (settings.enabled) {
      const { computeRiskScore } = await import('./captcha/risk');
      const { getRequiredDifficulty, assertCaptchaSatisfied } = await import('./captcha/service');
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
        gender: gender ? sanitizeInput(gender, 100) : undefined,
        birthday,
        emailVerified: false,
        preferences: {
          signupConsent: {
            acceptedAt: new Date().toISOString(),
            policyAccepted: true,
            adminDataAccess: !!adminDataAccess,
            signatureName: normalizedSignatureName,
            signatureDataUrl,
          },
        },
      },
    });

    const { token, refreshToken } = await createSession(user.id, userAgent || undefined, ip);
    const res = NextResponse.json({ id: user.id, email: user.email, token }, { status: 201 });
    setSessionCookie(res, token, refreshToken);

    const { recordDeviceSeen } = await import('./captcha/risk');
    recordDeviceSeen({ fingerprint, userId: user.id, ip, ua: userAgent, sessionId: captchaSession }).catch(() => {});

    // Send welcome + verification email (non-blocking)
    sendTemplateEmail(email, 'welcome', { name: name || email.split('@')[0] }, {
      fromEmail: 'noreply@send.tirbeo.app',
      fromName: 'Tirbeo',
    }).catch(err => console.error('[SIGNUP] Welcome email failed:', err?.message));

    // Send verification OTP
    const otpCode = Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => (b % 10).toString()).join('');
    const otpHash = await hashPassword(otpCode);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.otp.create({
      data: { userId: user.id, type: 'email', otpHash, expiresAt },
    });
    sendTemplateEmail(email, 'verify_email', { otp: otpCode, name: name || email.split('@')[0] }, {
      fromEmail: 'noreply@send.tirbeo.app',
      fromName: 'Tirbeo',
    }).catch(err => console.error('[SIGNUP] Verification email failed:', err?.message));

    return res;
  } catch (err: any) {
    console.error('[SIGNUP]', err?.message || err, err?.stack);
    return new NextResponse('Signup failed', { status: 400 });
  }
}

export async function requestSignupOtpHandler(request: NextRequest) {
  try {
    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
    if (!checkWindowLimit(`signup-otp:ip:${clientIp}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many requests. Please try again later.', { status: 429 });
    }
    if (!checkWindowLimit(`signup-otp:email:${email.toLowerCase()}`, 3, 15 * 60 * 1000)) {
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

export async function requestLoginOtpHandler(request: NextRequest) {
  try {
    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
    if (!checkWindowLimit(`login-otp:ip:${clientIp}`, 5, 15 * 60 * 1000)) {
      return new NextResponse('Too many requests. Please try again later.', { status: 429 });
    }
    if (!checkWindowLimit(`login-otp:email:${email.toLowerCase()}`, 3, 15 * 60 * 1000)) {
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
    const { email, otpCode } = await request.json();
    if (!email || typeof email !== 'string' || !otpCode || typeof otpCode !== 'string') {
      return new NextResponse('Email and code are required', { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true, email: true, isBanned: true, isSuspended: true, emailVerified: true } });
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
    const { checkWindowLimit } = await import('./captcha/risk');
    if (!checkWindowLimit(`login-otp-verify:ip:${clientIp}`, 10, 15 * 60 * 1000)) {
      return new NextResponse('Too many attempts. Please try again later.', { status: 429 });
    }

    const otpOk = await verifySignupOtp(email, otpCode);
    if (!otpOk) {
      const { logSecurityEvent } = await import('./security');
      logSecurityEvent({ request, userId: user.id, eventType: 'auth.login_failed', details: { reason: 'invalid_otp' } }).catch(() => {});
      return new NextResponse('Invalid or expired verification code', { status: 400 });
    }

    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, clientIp);
    const res = NextResponse.json({ id: user.id, email: user.email, token });
    setSessionCookie(res, token, refreshToken);
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
    const { token } = await request.json();
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
    const { code, email } = await request.json();
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

// Signup email verification (no session required)
export async function verifySignupEmailHandler(request: NextRequest) {
  try {
    const { email, code } = await request.json();
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
      const otpHash = await hashPassword(otpCode);
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
    const { code } = await request.json();
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
    const nonce = crypto.randomUUID();
    const stateToken = await signOauthStateToken(nonce, safeRedirect);
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
    const { checkWindowLimit } = await import('./captcha/risk');
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
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userInfoRes.ok) {
      return new NextResponse('Failed to fetch user info', { status: 500 });
    }
    const profile = await userInfoRes.json();
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

    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const fallback = `https://dashboard.${process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app'}`;
    const target = redirectTo || fallback;
    const res = NextResponse.redirect(target);
    setSessionCookie(res, token, refreshToken);
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
    const nonce = crypto.randomUUID();
    const stateToken = await signOauthStateToken(nonce, safeRedirect);
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
    const { checkWindowLimit } = await import('./captcha/risk');
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
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const userInfoRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userInfoRes.ok) {
      return new NextResponse('Failed to fetch user info', { status: 500 });
    }
    const profile = await userInfoRes.json();
    const githubId = String(profile.id);
    let email = profile.email;
    const name = profile.name || profile.login;
    const photoUrl = profile.avatar_url as string | undefined;

    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (emailsRes.ok) {
        const emails = await emailsRes.json();
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

    const redirectTo = state.redirect && isAllowedRedirect(state.redirect) ? state.redirect : undefined;
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const fallback = `https://dashboard.${process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app'}`;
    const res = NextResponse.redirect(redirectTo || fallback);
    setSessionCookie(res, token, refreshToken);
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
    const nonce = crypto.randomUUID();
    const stateToken = await signOauthStateToken(nonce, safeRedirect);
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
    const { checkWindowLimit } = await import('./captcha/risk');
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
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const userInfoRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userInfoRes.ok) {
      return new NextResponse('Failed to fetch user info', { status: 500 });
    }
    const profile = await userInfoRes.json();
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

    const redirectTo = state.redirect && isAllowedRedirect(state.redirect) ? state.redirect : undefined;
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    const { token, refreshToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const fallback = `https://dashboard.${process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app'}`;
    const res = NextResponse.redirect(redirectTo || fallback);
    setSessionCookie(res, token, refreshToken);
    clearOauthStateCookie(res, request);
    return res;
  } catch (err: any) {
    console.error('[DISCORD CALLBACK]', err?.message || err);
    return new NextResponse('Discord OAuth callback failed', { status: 500 });
  }
}

// Activity feed
export async function activityHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });

    const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 20, 100);
    const logs = await prisma.log.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, method: true, path: true, status: true, createdAt: true },
    });

    return NextResponse.json(logs);
  } catch (err: any) {
    console.error('[ACTIVITY]', err?.message || err);
    return new NextResponse('Failed to fetch activity', { status: 500 });
  }
}

// Workspace list
export async function listWorkspacesHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });

    const workspaces = await prisma.workspace.findMany({
      where: {
        OR: [
          { ownerId: session.userId },
          { memberships: { some: { userId: session.userId } } },
        ],
      },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        users: { select: { id: true, email: true, name: true } },
        _count: { select: { memberships: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(workspaces);
  } catch (err: any) {
    console.error('[LIST WORKSPACES]', err?.message || err);
    return new NextResponse('Failed to fetch workspaces', { status: 500 });
  }
}

// Workspace create
export async function createWorkspaceHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });

    const body = await request.json();
    const { name, slug } = body;
    if (!name || !slug) return new NextResponse('name and slug required', { status: 400 });
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 64) {
      return new NextResponse('Name must be 2-64 characters', { status: 400 });
    }
    if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 2 || slug.length > 48) {
      return new NextResponse('Slug must be 2-48 lowercase alphanumeric characters (dashes allowed)', { status: 400 });
    }

    const existing = await prisma.workspace.findUnique({ where: { slug } });
    if (existing) return new NextResponse('Slug already taken', { status: 409 });

    const workspace = await prisma.workspace.create({
      data: { name: name.trim(), slug: slug.trim(), ownerId: session.userId },
    });

    await prisma.membership.create({
      data: { userId: session.userId, workspaceId: workspace.id, role: 'ADMIN' },
    });

    return NextResponse.json(workspace, { status: 201 });
  } catch (err: any) {
    console.error('[CREATE WORKSPACE]', err?.message || err);
    return new NextResponse('Failed to create workspace', { status: 500 });
  }
}

export async function profileHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) {
      return new NextResponse('Unauthenticated', { status: 401 });
    }

    if (request.method === 'GET') {
      // Update lastActiveAt so user shows as "online"
      prisma.user.update({ where: { id: session.userId }, data: { lastActiveAt: new Date() } }).catch(() => {});

      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        select: {
          id: true,
          email: true,
          name: true,
          photoUrl: true,
          secondaryEmail: true,
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
          fontSize: true,
          reduceMotion: true,
          highContrast: true,
          isBanned: true,
          isSuspended: true,
        },
      });
      if (!user) return new NextResponse('User not found', { status: 404 });
      const { passwordHash, ...safeUser } = user as any;

      const backupCodeCount = await prisma.recoveryCode.count({ where: { userId: session.userId } });
      return NextResponse.json({ ...safeUser, hasPassword: !!passwordHash, hasBackupCodes: backupCodeCount > 0 });
    }

    if (request.method === 'PATCH') {
      const body = await request.json();
      const schema = z.object({
        name: z.string().min(1).optional(),
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
        github: z.string().optional().nullable(),
        twitter: z.string().optional().nullable(),
        companyName: z.string().optional().nullable(),
        companyRole: z.string().optional().nullable(),
        industry: z.string().optional().nullable(),
        companySize: z.string().optional().nullable(),
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
      if ('companyName' in data) { data.companyName = data.companyName; }
      const updated = await prisma.user.update({
        where: { id: session.userId },
        data,
        select: {
          id: true, email: true, name: true, photoUrl: true,
          phoneNumber: true, occupation: true, bio: true,
          website: true, linkedin: true, githubUsername: true, twitter: true,
          country: true, timezone: true, language: true,
          companyName: true, companyRole: true, industry: true, companySize: true,
          gender: true, birthday: true, secondaryEmail: true,
          createdAt: true, updatedAt: true,
        },
      });

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

      return NextResponse.json(updated);
    }

    return new NextResponse('Method not allowed', { status: 405 });
  } catch (err: any) {
    console.error('[PROFILE]', err?.message || err);
    return new NextResponse('Failed to fetch or update profile', { status: 500 });
  }
}

// Password reset — request OTP only
export async function requestPasswordResetOtpHandler(request: NextRequest) {
  try {
    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
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
    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
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
    const { email, method } = await request.json();
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }
    const resetMethod: 'otp' | 'magic_link' = method === 'magic_link' ? 'magic_link' : 'otp';
    const result = await requestPasswordReset(email, resetMethod);
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
    const { email, code, token } = await request.json();
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }
    if (!code && !token) {
      return new NextResponse('Code or token required', { status: 400 });
    }
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
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
    const body = await request.json();
    const resetToken = body.resetToken || body.token;
    const newPassword = body.newPassword || body.password;
    if (!resetToken || !newPassword) {
      return new NextResponse('Reset token and new password required', { status: 400 });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return new NextResponse('Password must be at least 8 characters', { status: 400 });
    }
    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
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
    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
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

    const { signMagicLinkToken } = await import('./auth/jwt');
    const token = await signMagicLinkToken(user.id);
    const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
    const callbackUrl = `https://accounts.${appDomain}/callback?magic_token=${token}`;

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
    const { token } = await request.json();
    if (!token || typeof token !== 'string') {
      return new NextResponse('Token required', { status: 400 });
    }

    const { verifyMagicLinkToken } = await import('./auth/jwt');
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
    setSessionCookie(res, sessionToken, refreshToken);

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

export async function deleteWorkspaceHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });

    const { workspaceId } = await request.json();
    if (!workspaceId) return new NextResponse('workspaceId required', { status: 400 });

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) return new NextResponse('Workspace not found', { status: 404 });
    if (workspace.ownerId !== session.userId) {
      return new NextResponse('Only the owner can delete a workspace', { status: 403 });
    }

    await prisma.workspace.delete({ where: { id: workspaceId } });
    return new NextResponse('Workspace deleted', { status: 200 });
  } catch (err: any) {
    console.error('[DELETE WORKSPACE]', err?.message || err);
    return new NextResponse('Failed to delete workspace', { status: 500 });
  }
}

export async function deleteWorkspaceByIdHandler(request: NextRequest, workspaceId: string) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) return new NextResponse('Workspace not found', { status: 404 });
    if (workspace.ownerId !== session.userId) {
      return new NextResponse('Only the owner can delete a workspace', { status: 403 });
    }

    await prisma.workspace.delete({ where: { id: workspaceId } });
    return new NextResponse('Workspace deleted', { status: 200 });
  } catch (err: any) {
    console.error('[DELETE WORKSPACE BY ID]', err?.message || err);
    return new NextResponse('Failed to delete workspace', { status: 500 });
  }
}

// ─── Account Recovery ───────────────────────────────────────

export async function accountRecoveryHandler(request: NextRequest) {
  try {
    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Always return success to prevent email enumeration
    if (!user) {
      return NextResponse.json({ message: 'If an account exists, recovery instructions have been sent.' });
    }

    const token = await signRecoveryToken(user.id);
    const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
    const recoveryUrl = `https://accounts.${appDomain}/recovery?token=${token}`;

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

// ─── Suspicious Login ───────────────────────────────────────

export async function suspiciousLoginConfirmHandler(request: NextRequest) {
  try {
    const { token } = await request.json();
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
    setSessionCookie(res, sessionToken, refreshToken);
    return res;
  } catch {
    return new NextResponse('Failed to confirm suspicious login', { status: 400 });
  }
}

export async function suspiciousLoginDenyHandler(request: NextRequest) {
  try {
    const { token } = await request.json();
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

export async function helpConfigHandler(request: NextRequest) {
  return NextResponse.json({
    articles: [
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
      { id: "40", title: "Mobile App Support", content: "Tirbeo is fully responsive on mobile browsers. A native app is coming soon.", category: "Troubleshooting", icon: "bug" },
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
    ],
    contactEmail: "support@tirbeo.app",
    faqEnabled: true,
  });
}

export async function faqHandler(request: NextRequest) {
  const category = request.nextUrl.searchParams.get('category') || '';
  const search = request.nextUrl.searchParams.get('search') || '';
  const help = await helpConfigHandler(request);
  const articles = (await help.json()).articles;
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

    const { SignJWT } = await import('jose');
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

export async function waitlistHandler(request: NextRequest) {
  try {
    const { email, lang, source, name } = await request.json();
    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
    if (!checkWindowLimit(`waitlist:ip:${clientIp}`, 5, 15 * 60 * 1000)) {
      return NextResponse.json({ error: 'Too many submissions. Please try again later.' }, { status: 429 });
    }

    const emailLower = email.toLowerCase().trim();
    const cleanName = name ? sanitizeInput(String(name), 100) : undefined;
    const finalSource = (source && ['hero', 'newsletter', 'navbar', 'waitlist', 'landing'].includes(source)) ? source : 'waitlist';

    const existing = await prisma.subscriber.findUnique({ where: { email: emailLower } });
    if (existing) {
      const updateData: Record<string, unknown> = {};
      if (cleanName && !existing.name) updateData.name = cleanName;
      if (lang) updateData.metadata = { ...(existing.metadata as Record<string, unknown> || {}), lang };

      await prisma.subscriber.update({ where: { email: emailLower }, data: updateData });
      return NextResponse.json({ message: 'You are already on the list!' }, { status: 200 });
    }

    await prisma.subscriber.create({
      data: {
        email: emailLower,
        name: cleanName,
        source: finalSource,
        metadata: lang ? { lang } : undefined,
      },
    });

    return NextResponse.json({ message: 'Successfully joined! We will be in touch.' }, { status: 201 });
  } catch (err: any) {
    console.error('[WAITLIST]', err?.message || err);
    return NextResponse.json({ error: 'Submission failed. Please try again.' }, { status: 500 });
  }
}

// ─── Feedback ───────────────────────────────────────────────

export async function feedbackHandler(request: NextRequest) {
  try {
    const { message, email, lang, source } = await request.json();
    if (!message || typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const { checkWindowLimit } = await import('./captcha/risk');
    if (!checkWindowLimit(`feedback:ip:${clientIp}`, 10, 15 * 60 * 1000)) {
      return NextResponse.json({ error: 'Too many submissions. Please try again later.' }, { status: 429 });
    }

    const finalSource = (source && ['widget', 'landing', 'footer', 'admin'].includes(source)) ? source : 'widget';

    const feedback = await prisma.feedback.create({
      data: {
        message: sanitizeInput(message.trim(), 20000),
        email: email ? sanitizeInput(String(email), 254) : undefined,
        lang: lang || undefined,
        source: finalSource,
      },
    });

    return NextResponse.json({ message: 'Thank you for your feedback!', id: feedback.id }, { status: 201 });
  } catch (err: any) {
    console.error('[FEEDBACK]', err?.message || err);
    return NextResponse.json({ error: 'Failed to submit feedback. Please try again.' }, { status: 500 });
  }
}

// ─── Admin: Subscribers ─────────────────────────────────────

export async function adminSubscribersHandler(request: NextRequest) {
  try {
    const session = await requireAdmin(request);
    if (session instanceof NextResponse) return session;

    const { searchParams } = new URL(request.url);
    const source = searchParams.get('source');
    const status = searchParams.get('status');
    const search = searchParams.get('search');
    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 200);

    const where: Record<string, unknown> = {};
    if (source) where.source = source;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [subscribers, total] = await Promise.all([
      prisma.subscriber.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
      prisma.subscriber.count({ where }),
    ]);

    return NextResponse.json({ subscribers, total });
  } catch (err: any) {
    console.error('[ADMIN SUBSCRIBERS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch subscribers' }, { status: 500 });
  }
}

// ─── Admin: Feedback ────────────────────────────────────────

export async function adminFeedbackHandler(request: NextRequest) {
  try {
    const session = await requireAdmin(request);
    if (session instanceof NextResponse) return session;

    const { searchParams } = new URL(request.url);
    const source = searchParams.get('source');
    const status = searchParams.get('status');
    const search = searchParams.get('search');
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100);

    const where: Record<string, unknown> = {};
    if (source) where.source = source;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { message: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [feedback, total] = await Promise.all([
      prisma.feedback.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
      prisma.feedback.count({ where }),
    ]);

    return NextResponse.json({ feedback, total });
  } catch (err: any) {
    console.error('[ADMIN FEEDBACK]', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch feedback' }, { status: 500 });
  }
}

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

    const body = await request.json().catch(() => ({}));
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
