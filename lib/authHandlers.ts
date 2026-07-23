import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from './db/prisma';
import { generateOtpCode, storeOtp, verifyOtpCode, sendEmailOtp, sendPhoneOtp } from './auth/otp';
import { generateOtpCode as genSignupOtp, storeSignupOtp, verifySignupOtp, sendSignupOtpEmail } from './auth/signup-otp';
import { hashPassword, verifyPassword } from './auth/password';
import { createSession, setSessionCookie, clearSessionCookie, revokeSession, getSession } from './session';
import { signTemp2faToken, verifyTemp2faToken, signMagicLinkToken, verifyMagicLinkToken, signOauthStateToken, verifyOauthStateToken } from './auth/jwt';
import { verifyTotp } from './auth/totp';
import { sendTemplateEmail } from './email';
import { requestPasswordReset, verifyPasswordReset, confirmPasswordReset } from './auth/password-reset';
import { createAuditEvent } from './audit';

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

const OAUTH_STATE_COOKIE = '__oauth_state';

function setOauthStateCookie(res: NextResponse, nonce: string) {
  res.cookies.set(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
}

function clearOauthStateCookie(res: NextResponse) {
  res.cookies.set(OAUTH_STATE_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function loginHandler(request: NextRequest) {
  try {
    const parsed = loginSchema.safeParse(await request.json());
    if (!parsed.success) {
      return new NextResponse('Invalid email or password', { status: 400 });
    }
    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return new NextResponse("This account doesn't exist. Please sign up first.", { status: 404 });
    }
    if (!user.passwordHash) {
      return new NextResponse('This account uses social login. Please sign in with Google or GitHub.', { status: 401 });
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      return new NextResponse('Incorrect password. Please try again.', { status: 401 });
    }

    if (user.is2FAEnabled) {
      const tempToken = await signTemp2faToken(user.id);
      return NextResponse.json({ needs2FA: true, tempToken, userId: user.id });
    }

    const ip = request.headers.get('x-forwarded-for') || '';
    const { token } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.json({ id: user.id, email: user.email });
    setSessionCookie(res, token);
    return res;
  } catch (err: any) {
    console.error('[LOGIN]', err?.message || err);
    return new NextResponse('Login failed', { status: 400 });
  }
}

export async function verify2faLoginHandler(request: NextRequest) {
  try {
    const { tempToken, token: totpCode } = await request.json();
    if (typeof tempToken !== 'string' || typeof totpCode !== 'string') {
      return new NextResponse('Invalid payload', { status: 400 });
    }

    const userId = await verifyTemp2faToken(tempToken);
    if (!userId) return new NextResponse('Invalid or expired temp token', { status: 401 });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpSecret || !user.is2FAEnabled) {
      return new NextResponse('2FA not enabled', { status: 400 });
    }

    if (!await verifyTotp(totpCode, user.totpSecret)) {
      return new NextResponse('Invalid 2FA code', { status: 401 });
    }

    const ip = request.headers.get('x-forwarded-for') || '';
    const { token } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.json({ id: user.id, email: user.email });
    setSessionCookie(res, token);
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

    const userId = await verifyTemp2faToken(tempToken);
    if (!userId) return new NextResponse('Invalid or expired temp token', { status: 401 });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.is2FAEnabled) {
      return new NextResponse('2FA not enabled', { status: 400 });
    }

    const rc = await prisma.recoveryCode.findFirst({
      where: { userId, code: recoveryCode, used: false },
    });
    if (!rc) return new NextResponse('Invalid recovery code', { status: 401 });

    await prisma.recoveryCode.update({
      where: { id: rc.id },
      data: { used: true, usedAt: new Date() },
    });

    const ip = request.headers.get('x-forwarded-for') || '';
    const { token } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.json({ id: user.id, email: user.email });
    setSessionCookie(res, token);
    return res;
  } catch {
    return new NextResponse('Recovery code verification failed', { status: 400 });
  }
}

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).optional(),
  otpCode: z.string().length(6).optional(),
});

export async function signupHandler(request: NextRequest) {
  try {
    const parsed = signupSchema.safeParse(await request.json());
    if (!parsed.success) {
      return new NextResponse('Invalid request payload', { status: 400 });
    }
    const { email, password, name, otpCode } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return new NextResponse('Email already registered', { status: 409 });
    }

    if (!otpCode) {
      return new NextResponse('Verification code required', { status: 400 });
    }

    const otpOk = await verifySignupOtp(email, otpCode);
    if (!otpOk) {
      return new NextResponse('Invalid or expired verification code', { status: 400 });
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email, passwordHash, name },
    });

    const ip = request.headers.get('x-forwarded-for') || '';
    const { token } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
    setSessionCookie(res, token);

    // Send welcome email (non-blocking)
    sendTemplateEmail(email, 'welcome', { name: name || email.split('@')[0] })
      .catch(err => console.error('[SIGNUP] Welcome email failed:', err?.message));

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
      if (!emailSent) console.log(`[SIGNUP OTP] Email failed for ${email}, code: ${code}`);
    } catch (emailErr) {
      console.error('[SIGNUP OTP] Email send error:', emailErr);
      console.log(`[SIGNUP OTP] FALLBACK CODE for ${email}: ${code}`);
    }
    return NextResponse.json({ message: 'Verification code sent to email' }, { status: 200 });
  } catch (err: any) {
    console.error('[SIGNUP OTP REQUEST]', err?.message || err, err?.stack);
    return new NextResponse(`Failed to process request: ${err?.message || 'unknown'}`, { status: 500 });
  }
}

export async function requestLoginOtpHandler(request: NextRequest) {
  try {
    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
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
      if (!emailSent) console.log(`[LOGIN OTP] Email failed for ${email}, code: ${code}`);
    } catch (emailErr) {
      console.error('[LOGIN OTP] Email send error:', emailErr);
      console.log(`[LOGIN OTP] FALLBACK CODE for ${email}: ${code}`);
    }
    return NextResponse.json({ message: 'Verification code sent to your email' }, { status: 200 });
  } catch (err: any) {
    console.error('[LOGIN OTP REQUEST]', err?.message || err, err?.stack);
    return new NextResponse(`Failed to process request: ${err?.message || 'unknown'}`, { status: 500 });
  }
}

export async function verifyLoginOtpHandler(request: NextRequest) {
  try {
    const { email, otpCode } = await request.json();
    if (!email || typeof email !== 'string' || !otpCode || typeof otpCode !== 'string') {
      return new NextResponse('Email and code are required', { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) {
      return new NextResponse('No account found with this email', { status: 404 });
    }

    const otpOk = await verifySignupOtp(email, otpCode);
    if (!otpOk) {
      return new NextResponse('Invalid or expired verification code', { status: 400 });
    }

    const ip = request.headers.get('x-forwarded-for') || '';
    const { token } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.json({ id: user.id, email: user.email });
    setSessionCookie(res, token);
    return res;
  } catch (err) {
    console.error('[LOGIN OTP VERIFY]', err);
    return new NextResponse('Verification failed', { status: 500 });
  }
}

export async function logoutHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (session) {
      await revokeSession(session.sessionId);
    }
    const res = new NextResponse('Logged out', { status: 200 });
    clearSessionCookie(res);
    return res;
  } catch {
    return new NextResponse('Logout failed', { status: 400 });
  }
}

// Email OTP - request
export async function requestEmailOtpHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });
    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || !user.email) return new NextResponse('User email missing', { status: 400 });
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

// Phone OTP - request
export async function requestPhoneOtpHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return new NextResponse('Unauthenticated', { status: 401 });
    const user = await prisma.user.findUnique({ where: { id: session.userId } });
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
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      return new NextResponse('Google OAuth not configured', { status: 500 });
    }
    const sp = request.nextUrl.searchParams;
    const redirectTo = sp.get('redirect');
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
    setOauthStateCookie(res, nonce);
    return res;
  } catch (err: any) {
    console.error('[GOOGLE AUTH]', err?.message || err);
    return new NextResponse('Failed to initiate Google auth', { status: 500 });
  }
}

// Google OAuth callback handler
export async function googleAuthCallbackHandler(request: NextRequest) {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
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

    let user = await prisma.user.findUnique({ where: { googleId } });
    if (!user) {
      user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        await prisma.user.update({
          where: { id: user.id },
          data: { googleId, photoUrl: user.photoUrl || photoUrl || undefined },
        });
      } else {
        user = await prisma.user.create({
          data: {
            email, name, googleId, photoUrl: photoUrl || undefined,
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

    const ip = request.headers.get('x-forwarded-for') || '';
    const { token } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.redirect(redirectTo || `https://dashboard.${process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app'}`);
    setSessionCookie(res, token);
    clearOauthStateCookie(res);
    return res;
  } catch (err: any) {
    console.error('[GOOGLE CALLBACK]', err?.message || err);
    return new NextResponse('Google OAuth callback failed', { status: 500 });
  }
}

// GitHub OAuth - start flow
export async function githubAuthRedirectHandler(request: NextRequest) {
  try {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const redirectUri = process.env.GITHUB_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      return new NextResponse('GitHub OAuth not configured', { status: 500 });
    }
    const sp = request.nextUrl.searchParams;
    const redirectTo = sp.get('redirect');
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
    setOauthStateCookie(res, nonce);
    return res;
  } catch (err: any) {
    console.error('[GITHUB AUTH]', err?.message || err);
    return new NextResponse('Failed to initiate GitHub auth', { status: 500 });
  }
}

// GitHub OAuth callback handler
export async function githubAuthCallbackHandler(request: NextRequest) {
  try {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    const redirectUri = process.env.GITHUB_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
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

    let user = await prisma.user.findUnique({ where: { githubId } });
    if (!user && email) {
      user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        await prisma.user.update({
          where: { id: user.id },
          data: { githubId, photoUrl: user.photoUrl || photoUrl || undefined },
        });
      } else {
        user = await prisma.user.create({
          data: {
            email: email || `${githubId}@github.user`, name, githubId,
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
    const ip = request.headers.get('x-forwarded-for') || '';
    const { token } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.redirect(redirectTo || `https://dashboard.${process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app'}`);
    setSessionCookie(res, token);
    clearOauthStateCookie(res);
    return res;
  } catch (err: any) {
    console.error('[GITHUB CALLBACK]', err?.message || err);
    return new NextResponse('GitHub OAuth callback failed', { status: 500 });
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
        owner: { select: { id: true, email: true, name: true } },
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

    const existing = await prisma.workspace.findUnique({ where: { slug } });
    if (existing) return new NextResponse('Slug already taken', { status: 409 });

    const workspace = await prisma.workspace.create({
      data: { name, slug, ownerId: session.userId },
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
          github: true,
          twitter: true,
          companyName: true,
          companyRole: true,
          industry: true,
          companySize: true,
          adminRole: true,
          is2FAEnabled: true,
          createdAt: true,
          updatedAt: true,
          lastActiveAt: true,
          emailVerified: true,
          phoneVerified: true,
          passwordHash: true,
          preferences: true,
        },
      });
      if (!user) return new NextResponse('User not found', { status: 404 });
      return NextResponse.json({ ...user, hasPassword: !!(user as any).passwordHash });
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
      });

      // Log activity
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

// Password reset — request (send email with code + link)
export async function requestPasswordResetHandler(request: NextRequest) {
  try {
    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      return new NextResponse('Email is required', { status: 400 });
    }
    const result = await requestPasswordReset(email);
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
    const { email, resetToken, newPassword } = await request.json();
    if (!email || !resetToken || !newPassword) {
      return new NextResponse('Email, reset token, and new password required', { status: 400 });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return new NextResponse('Password must be at least 8 characters', { status: 400 });
    }
    const result = await confirmPasswordReset(email, resetToken, newPassword);
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

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
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
      resp.devLink = callbackUrl;
      resp.devMessage = 'Email delivery failed. Use this link for testing.';
      console.log(`[MAGIC LINK] FALLBACK LINK for ${email}: ${callbackUrl}`);
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

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return new NextResponse('User not found', { status: 404 });
    }

    const ip = request.headers.get('x-forwarded-for') || '';
    const { token: sessionToken } = await createSession(user.id, request.headers.get('user-agent') || undefined, ip);
    const res = NextResponse.json({ id: user.id, email: user.email });
    setSessionCookie(res, sessionToken);

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
    ],
    contactEmail: "support@tirbeo.app",
    faqEnabled: true,
  });
}
