import { NextResponse, NextRequest } from 'next/server';
import { checkRateLimit } from './lib/auth/rate-limit';
import { isSuspicious } from './lib/auth/suspicious-activity';
import { verifyTurnstile, getTurnstileSiteKey, isTurnstileConfigured } from './lib/auth/turnstile';
import { detectXss } from './lib/auth/xss-scan';

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (['localhost', '127.0.0.1'].includes(u.hostname)) return true;
    if (u.hostname === 'api.tirbeo.app') return true;
    if (u.hostname.endsWith('.tirbeo.app')) return true;
    if (u.hostname === 'api-tirbeo.vercel.app') return true;
    return false;
  } catch {
    return false;
  }
}

// ─── XSS / malicious payload scanning ───
const MAX_SCAN_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;

async function scanRequestForPayloads(request: NextRequest): Promise<string | null> {
  const urlHit = detectXss(request.nextUrl.searchParams.toString()) || detectXss(request.nextUrl.pathname);
  if (urlHit) return urlHit;

  if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
    try {
      const clone = request.clone();
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/json') || contentType.includes('text/plain') || contentType.includes('application/x-www-form-urlencoded')) {
        const text = await clone.text();
        if (text.length > MAX_BODY_BYTES) {
          return 'Request body too large';
        }
        if (text && text.length <= MAX_SCAN_BYTES) {
          const bodyHit = detectXss(text);
          if (bodyHit) return bodyHit;
        }
      }
    } catch {
      // Body read failed — skip scanning body
    }
  }
  return null;
}

async function reportBlockedRequest(request: NextRequest, reason: string) {
  const key = process.env.SECURITY_LOG_KEY;
  if (!key) return;
  const origin = request.nextUrl.origin;
  try {
    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    await fetch(`${origin}/api/security/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-security-log-key': key },
      body: JSON.stringify({
        eventType: 'payload.blocked_xss',
        severity: 'warning',
        details: {
          reason,
          ip,
          method: request.method,
          path: request.nextUrl.pathname,
          query: request.nextUrl.searchParams.toString().slice(0, 500),
          rayId: request.headers.get('cf-ray') || request.headers.get('x-vercel-id') || '',
        },
      }),
    }).catch(() => {});
  } catch {
    // Best-effort logging only
  }
}

const isDev = process.env.NODE_ENV === 'development';

const securityHeaders = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=(), serial=(), midi=(), sync-xhr=(), autoplay=(), display-capture=(), fullscreen=(), picture-in-picture=(), screen-wake-lock=(), clipboard-read=(), clipboard-write=()',
  'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https: wss:; frame-ancestors 'none';`,
};

function addCorsHeaders(response: NextResponse, origin: string) {
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-CSRF-Token, x-turnstile-token');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Max-Age', '86400');
}

function jsonResponse(origin: string, body: any, status: number) {
  const res = NextResponse.json(body, { status });
  if (origin) addCorsHeaders(res, origin);
  return res;
}

const CSRF_COOKIE_NAME = '__csrf';

function validateCsrf(request: NextRequest): boolean {
  const headerToken = request.headers.get('x-csrf-token');
  const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  if (!headerToken || !cookieToken) return false;
  if (headerToken.length !== cookieToken.length) return false;
  let diff = 0;
  for (let i = 0; i < headerToken.length; i++) {
    diff |= headerToken.charCodeAt(i) ^ cookieToken.charCodeAt(i);
  }
  return diff === 0;
}

// State-changing methods that require CSRF validation for cookie-authed requests
const STATE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Paths exempt from CSRF (public auth endpoints that don't have a session yet)
const CSRF_EXEMPT_PATHS = [
  '/api/auth/login', '/api/auth/signup', '/api/auth/logout',
  '/api/auth/signup-otp/request', '/api/auth/signup-otp/verify',
  '/api/auth/login-otp/request', '/api/auth/login-otp/verify',
  '/api/auth/magic-link/request', '/api/auth/magic-link/verify',
  '/api/auth/verify-2fa', '/api/auth/recovery-2fa',
  '/api/auth/password-reset/request', '/api/auth/password-reset/verify', '/api/auth/password-reset/confirm',
  '/api/auth/email-otp/request', '/api/auth/email-otp/verify',
  '/api/auth/phone-otp/request', '/api/auth/phone-otp/verify',
  '/api/admin/login', '/api/admin/verify-2fa',
  '/api/public/', '/api/newsletter/',
  '/api/waitlist',
  '/api/feedback',
  '/api/passkey/auth/options', '/api/passkey/auth/verify',
  '/auth/google', '/auth/google/callback', '/auth/github', '/auth/github/callback',
  '/auth/discord', '/auth/discord/callback',
  '/api/captcha/', '/api/health',
  '/api/security/log',
];

export async function proxy(request: NextRequest) {
  const origin = request.headers.get('origin') || '';
  const corsOk = isAllowedOrigin(origin);
  const allowedOrigin = corsOk ? origin : '';

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    if (corsOk) {
      const preflightResponse = new NextResponse(null, { status: 204 });
      addCorsHeaders(preflightResponse, origin);
      return preflightResponse;
    }
    return new NextResponse(null, { status: 204 });
  }

  const response = NextResponse.next();
  Object.entries(securityHeaders).forEach(([k, v]) => response.headers.set(k, v));

  if (corsOk) {
    addCorsHeaders(response, origin);
  }

  const ip = request.headers.get('x-forwarded-for') || '' || 'unknown';
  const pathname = request.nextUrl.pathname;

  // ── XSS / malicious payload blocking ──
  const payloadHit = await scanRequestForPayloads(request);
  if (payloadHit) {
    reportBlockedRequest(request, payloadHit);
    return jsonResponse(allowedOrigin, {
      error: 'Request blocked: malicious payload detected',
      securityBlocked: true,
      reason: payloadHit,
    }, 403);
  }

  // ── Rate limiting ──
  const isAuth = pathname.startsWith('/api/auth/login') || pathname.startsWith('/api/auth/signup') || pathname.startsWith('/api/auth/verify-2fa') || pathname.startsWith('/api/auth/recovery-2fa') || pathname.startsWith('/api/auth/login-otp') || pathname.startsWith('/api/auth/password-reset') || pathname.startsWith('/api/auth/signup-otp') || pathname.startsWith('/api/auth/magic-link');
  const rateOk = await checkRateLimit(`${ip}:${pathname}`, isAuth);
  if (!rateOk) {
    return jsonResponse(allowedOrigin, { error: 'Too many requests. Please try again later.' }, 429);
  }

  // ── Turnstile captcha for suspicious IPs ──
  if (isAuth && isTurnstileConfigured() && isSuspicious(ip)) {
    const turnstileToken = request.headers.get('x-turnstile-token') || '';
    if (!turnstileToken) {
      return jsonResponse(allowedOrigin, {
        error: 'Captcha verification required',
        turnstileRequired: true,
        siteKey: getTurnstileSiteKey(),
      }, 403);
    }
    const valid = await verifyTurnstile(turnstileToken, ip);
    if (!valid) {
      return jsonResponse(allowedOrigin, { error: 'Captcha verification failed' }, 403);
    }
  }

  // ── Public paths — no auth or CSRF required ──
  const publicPaths = [
    '/api/auth/login', '/api/auth/signup', '/api/auth/logout',
    '/api/auth/verify-email',
    '/api/auth/email-exists',
    '/api/auth/signup-otp/request', '/api/auth/login-otp/request', '/api/auth/login-otp/verify',
    '/api/auth/magic-link/request', '/api/auth/magic-link/verify',
    '/api/auth/verify-2fa', '/api/auth/recovery-2fa',
    '/api/auth/google', '/api/auth/google/callback', '/api/auth/github', '/api/auth/github/callback',
    '/api/auth/password-reset/request', '/api/auth/password-reset/verify', '/api/auth/password-reset/confirm',
    '/api/auth/email-otp/request', '/api/auth/email-otp/verify',
    '/api/auth/phone-otp/request', '/api/auth/phone-otp/verify',
    '/api/auth/account-recovery', '/api/auth/recovery-email/send-code',
    '/api/auth/suspicious-login/confirm', '/api/auth/suspicious-login/deny',
    '/api/auth/verify',
    '/api/admin/login', '/api/admin/verify-2fa',
    '/api/public/', '/api/newsletter/',
    '/api/waitlist',
    '/api/feedback',
    '/api/forms/public/',
    '/api/passkey/auth/options', '/api/passkey/auth/verify',
    '/auth/google', '/auth/google/callback', '/auth/github', '/auth/github/callback',
    '/auth/discord', '/auth/discord/callback',
     '/api/captcha/challenge', '/api/captcha/status', '/api/captcha/verify', '/api/captcha/image/',
     '/api/image/',
     '/api/health',
    '/api/security/log',
  ];

const isPublicPath = publicPaths.some(p => pathname.startsWith(p));
if (isPublicPath) return response;

// ── Authentication check ──
const hasAuthHeader = !!request.headers.get('authorization');
const cookie = request.cookies.get('__session')?.value;
const hasCookie = !!cookie;

if (!hasCookie && !hasAuthHeader) {
  return jsonResponse(allowedOrigin, { error: 'Authentication required. Provide a session cookie or Authorization: Bearer <api_key> header.' }, 401);
}

if (hasAuthHeader) {
  const authHeader = request.headers.get('authorization') || '';
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return jsonResponse(allowedOrigin, { error: 'Invalid Authorization header format. Expected: Bearer <token>' }, 401);
  }
}

// ── CAPTCHA check for suspicious users ──
if (hasCookie && STATE_METHODS.has(request.method)) {
  try {
    const { verifyToken } = await import('./lib/auth/jwt');
    const payload = await verifyToken(cookie!);
    if (payload?.sub) {
      const { isBlocked, getRequiredDifficulty, getCaptchaSettings } = await import('./lib/captcha/service');
      const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
      const blockStatus = await isBlocked(payload.sub, payload.sid, ip);
      
      if (blockStatus.blocked) {
        return jsonResponse(allowedOrigin, {
          error: 'Access blocked due to suspicious activity',
          blocked: true,
          rayId: blockStatus.rayId,
          reason: blockStatus.reason,
          expiresAt: blockStatus.expiresAt,
        }, 403);
      }

      // For users with warnings, require CAPTCHA verification
      const settings = await getCaptchaSettings();
      if (settings.enabled && settings.autoEnforce) {
        const difficulty = await getRequiredDifficulty(payload.sub, payload.sid, ip);
        if (difficulty !== 'easy') {
          const captchaHeader = request.headers.get('x-captcha-verified');
          if (captchaHeader !== 'true') {
            return jsonResponse(allowedOrigin, {
              error: 'CAPTCHA verification required',
              captchaRequired: true,
              difficulty,
            }, 403);
          }
        }
      }
    }
  } catch {
    // CAPTCHA check failed - allow request but log it
  }
}

  // ── CSRF validation for cookie-authed state-changing requests ──
  if (hasCookie && STATE_METHODS.has(request.method)) {
    const isCsrfExempt = CSRF_EXEMPT_PATHS.some(p => pathname.startsWith(p));
    if (!isCsrfExempt) {
      if (!validateCsrf(request)) {
        return jsonResponse(allowedOrigin, {
          error: 'CSRF token missing or invalid. Include X-CSRF-Token header matching __csrf cookie.',
        }, 403);
      }
    }
  }

  // ── Check banned/suspended for cookie-authed state changes ──
  if (hasCookie && STATE_METHODS.has(request.method)) {
    try {
      const { verifyToken } = await import('./lib/auth/jwt');
      const payload = await verifyToken(cookie!);
      if (payload?.sub) {
        const { prisma } = await import('./lib/db/prisma');
        const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isBanned: true, isSuspended: true } });
        if (user?.isBanned) {
          return jsonResponse(allowedOrigin, { error: 'Account has been banned' }, 403);
        }
        if (user?.isSuspended) {
          return jsonResponse(allowedOrigin, { error: 'Account has been suspended' }, 403);
        }
      }
    } catch {
      // Cookie verification failed — that's OK, the handler will re-check
    }
  }

  // ── Check banned/suspended for API key-authed state changes ──
  if (hasAuthHeader && STATE_METHODS.has(request.method)) {
    try {
      const { authenticateApiKey } = await import('./lib/auth/api-key');
      const apiKeyResult = await authenticateApiKey(request);
      if (apiKeyResult?.userId) {
        const { prisma } = await import('./lib/db/prisma');
        const user = await prisma.user.findUnique({ where: { id: apiKeyResult.userId }, select: { isBanned: true, isSuspended: true } });
        if (user?.isBanned) {
          return jsonResponse(allowedOrigin, { error: 'Account has been banned' }, 403);
        }
        if (user?.isSuspended) {
          return jsonResponse(allowedOrigin, { error: 'Account has been suspended' }, 403);
        }
      }
    } catch {
      // API key verification failed — that's OK, the handler will re-check
    }
  }

  return response;
}

export const config = {
  matcher: ['/api/:path*', '/auth/:path*'],
};
