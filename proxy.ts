import { NextResponse, NextRequest } from 'next/server';
import { checkRateLimitWithInfo } from './lib/auth/rate-limit';
import { isSuspicious } from './lib/auth/suspicious-activity';
import { verifyTurnstile, getTurnstileSiteKey, isTurnstileConfigured } from './lib/auth/turnstile';
import { detectXss } from './lib/auth/xss-scan';
import { getMaintenanceState } from './lib/ws/server';

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
  // Constant-time comparison to prevent timing attacks
  let diff = 0;
  for (let i = 0; i < headerToken.length; i++) {
    diff |= headerToken.charCodeAt(i) ^ cookieToken.charCodeAt(i);
  }
  return diff === 0;
}

// Enhanced CSRF validation with nonce support
function validateCsrfWithNonce(request: NextRequest): boolean {
  const headerToken = request.headers.get('x-csrf-token');
  const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  const nonceHeader = request.headers.get('x-csrf-nonce');
  
  // Standard CSRF validation
  if (headerToken && cookieToken) {
    return validateCsrf(request);
  }
  
  // Nonce-based validation for state-changing requests
  if (nonceHeader && cookieToken) {
    // Nonce should be a timestamp-based token
    try {
      const nonceTime = parseInt(nonceHeader.split(':')[0] || '0', 10);
      const now = Date.now();
      // Nonce is valid for 5 minutes
      if (Math.abs(now - nonceTime) < 5 * 60 * 1000) {
        return true;
      }
    } catch {}
  }
  
  return false;
}

// State-changing methods that require CSRF validation for cookie-authed requests
const STATE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Paths exempt from CSRF (public auth endpoints that don't have a session yet)
const CSRF_EXEMPT_PATHS = [
  '/api/auth/login', '/api/auth/signup', '/api/auth/logout',
  '/api/auth/refresh',
  '/api/auth/email-exists', '/api/auth/username-exists',
  '/api/auth/signup-otp/request', '/api/auth/signup-otp/verify',
  '/api/auth/login-otp/request', '/api/auth/login-otp/verify',
  '/api/auth/magic-link/request', '/api/auth/magic-link/verify',
  '/api/auth/verify-2fa', '/api/auth/recovery-2fa',
  '/api/auth/password-reset/request', '/api/auth/password-reset/verify', '/api/auth/password-reset/confirm',
  '/api/auth/email-otp/request', '/api/auth/email-otp/verify',
  '/api/auth/phone-otp/request', '/api/auth/phone-otp/verify',
  '/api/admin/login', '/api/admin/verify-2fa', '/api/admin/change-password',
  '/api/public/', '/api/newsletter/',
  '/api/waitlist',
  '/api/feedback',    '/api/passkey/register/options', '/api/passkey/register/verify', '/api/passkey/list',
  '/api/passkey/auth/options', '/api/passkey/auth/verify',
  '/auth/google', '/auth/google/callback', '/auth/github', '/auth/github/callback',
  '/auth/discord', '/auth/discord/callback',
  '/api/auth/oauth/merge',
  '/api/auth/oauth/pending', '/api/auth/oauth/complete', '/api/auth/oauth-consent', '/api/auth/oauth/consent',
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

  const rawIp = request.headers.get('x-forwarded-for') || 'unknown';
  const ip = rawIp.split(',')[0].trim() || 'unknown';
  const pathname = request.nextUrl.pathname;

  // ── Early cookie extraction for maintenance check and admin detection ──
  const preCookie = request.cookies.get('__session')?.value;
  const preHasCookie = !!preCookie;
  let isAdminUser = false;
  
  // Quick admin check for rate limit bypass — cache the payload so we
  // avoid re-verifying the JWT 2-3 more times below.
  let adminUserId: string | undefined;
  let adminRole: string | undefined;
  let cachedPayload: { sub: string; sid: string; adminRole?: string } | null = null;
  if (preHasCookie) {
    try {
      const { verifyToken } = await import('./lib/auth/jwt');
      const payload = await verifyToken(preCookie!);
      if (payload) {
        cachedPayload = payload as any;
        if (payload.adminRole) {
          isAdminUser = true;
          adminUserId = payload.sub;
          adminRole = payload.adminRole;
        }
      }
    } catch {
      // Not a valid token, continue as regular user
    }
  }
  
  // Admin API key check — requires a valid ADMIN_KEY env var to match against
  if (!isAdminUser) {
    const adminKey = request.headers.get('x-admin-key');
    const expectedKey = process.env.ADMIN_KEY || process.env.ADMIN_API_KEY;
    if (adminKey && expectedKey && adminKey === expectedKey) {
      isAdminUser = true;
    }
  }
  
  // ── Maintenance mode check ──
  const maintenance = getMaintenanceState();
  if (maintenance.enabled) {
    // Allow health checks, admin endpoints, and WebSocket
    const maintenanceExempt = [
      '/api/health',
      '/api/debug/',
      '/api/admin/',
      '/api/admin/login',
      '/api/admin/verify-2fa',
      '/api/security/log',
    ];
    const isMaintenanceExempt = maintenanceExempt.some(p => pathname.startsWith(p));
    
    if (!isMaintenanceExempt) {
      // Use cached JWT payload instead of re-verifying (saves ~2-5s per request)
      if (cachedPayload?.sub && maintenance.allowedUsers.includes(cachedPayload.sub)) {
        // User is allowed during maintenance
      } else {
        return jsonResponse(allowedOrigin, {
          error: maintenance.message,
          maintenanceMode: true,
          estimatedEnd: maintenance.estimatedEnd ? new Date(maintenance.estimatedEnd).toISOString() : null,
        }, 503);
      }
    }
  }

  // ── XSS / malicious payload blocking ──
  // URL param scanning always runs (fast string check).
  // Body scanning is skipped for GET/HEAD and known-safe internal paths.
  const urlHit = detectXss(request.nextUrl.searchParams.toString()) || detectXss(pathname);
  if (urlHit) {
    reportBlockedRequest(request, urlHit);
    return jsonResponse(allowedOrigin, {
      error: 'Request blocked: malicious payload detected',
      securityBlocked: true,
      reason: urlHit,
    }, 403);
  }
  const isGetRequest = request.method === 'GET' || request.method === 'HEAD';
  const skipBodyScan = isGetRequest || pathname.startsWith('/api/captcha/status') || pathname.startsWith('/api/health') || pathname.startsWith('/api/public/') || pathname.startsWith('/api/forms/public/');
  if (!skipBodyScan) {
    const payloadHit = await scanRequestForPayloads(request);
    // URL XSS already checked above — only body result matters here
    if (payloadHit) {
      reportBlockedRequest(request, payloadHit);
      return jsonResponse(allowedOrigin, {
        error: 'Request blocked: malicious payload detected',
        securityBlocked: true,
        reason: payloadHit,
      }, 403);
    }
  }

  // ── Rate limiting (admins get 10x higher limits) ──
  const isAuth = pathname.startsWith('/api/auth/login') || pathname.startsWith('/api/auth/signup') || pathname.startsWith('/api/auth/verify-2fa') || pathname.startsWith('/api/auth/recovery-2fa') || pathname.startsWith('/api/auth/login-otp') || pathname.startsWith('/api/auth/password-reset') || pathname.startsWith('/api/auth/signup-otp') || pathname.startsWith('/api/auth/magic-link');
  const rateResult = await checkRateLimitWithInfo(`${ip}:${pathname}`, isAuth, undefined, isAdminUser, adminUserId, adminRole);
  if (!rateResult.allowed) {
    const resp = jsonResponse(allowedOrigin, { error: 'Too many requests. Please try again later.' }, 429);
    resp.headers.set('X-RateLimit-Limit', String(rateResult.limit));
    resp.headers.set('X-RateLimit-Remaining', '0');
    resp.headers.set('X-RateLimit-Reset', String(rateResult.reset));
    return resp;
  }

  // ── Turnstile captcha for suspicious IPs ──
  if (!isDev && isAuth && isTurnstileConfigured() && isSuspicious(ip)) {
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
    '/api/auth/username-exists',
    '/api/auth/signup-otp/request', '/api/auth/signup-otp/verify',
    '/api/auth/login-otp/request', '/api/auth/login-otp/verify',
    '/api/auth/magic-link/request', '/api/auth/magic-link/verify',
    '/api/auth/verify-2fa', '/api/auth/recovery-2fa',
    '/api/auth/google', '/api/auth/google/callback', '/api/auth/github', '/api/auth/github/callback', '/api/auth/discord', '/api/auth/discord/callback',
    '/api/auth/oauth/merge', // login-merge: authorized by signed short-lived token in body, no session involved
    '/api/auth/oauth/pending', '/api/auth/oauth/complete', '/api/auth/oauth-consent', '/api/auth/oauth/consent',
    '/api/auth/password-reset/request', '/api/auth/password-reset/verify', '/api/auth/password-reset/confirm',
    '/api/auth/email-otp/request', '/api/auth/email-otp/verify', '/api/auth/phone-otp/request', '/api/auth/phone-otp/verify',
    '/api/auth/account-recovery', '/api/auth/recovery-email/send-code',
    '/api/auth/refresh',
    '/api/auth/suspicious-login/confirm', '/api/auth/suspicious-login/deny',
    '/api/auth/verify',
    '/api/admin/login', '/api/admin/verify-2fa', '/api/admin/change-password',
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
     '/api/debug/',
     '/api/email/unsubscribe',
     '/api/emails/unsubscribe',
  ];

// Public form submission: POST /api/forms/{slug}/submit (auth via access_key in body)
const isPublicFormSubmit = /^\/api\/forms\/[^/]+\/submit\/?$/.test(pathname) && request.method === 'POST';
const isPublicPath = publicPaths.some(p => pathname.startsWith(p)) || isPublicFormSubmit;
if (isPublicPath) return response;


// ── Authentication check ──
const hasAuthHeader = !!request.headers.get('authorization');
const cookie = request.cookies.get('__session')?.value;
const hasCookie = !!cookie;

if (!hasCookie && !hasAuthHeader) {
  return jsonResponse(allowedOrigin, { error: 'Not authenticated' }, 401);
}

// ── Account status enforcement (banned / suspended) ──
// Runs once per authenticated request. Banned users get 403 ACCOUNT_BANNED;
// suspended users get 403 ACCOUNT_SUSPENDED with reason + until; expired
// suspensions are lifted automatically on first hit.
const statusExempt = ['/api/auth/', '/api/health', '/api/users/me/status'];
let statusResponse: NextResponse | null = null;
if (!statusExempt.some(p => pathname.startsWith(p))) {
  try {
    const { verifyToken } = await import('./lib/auth/jwt');
    const tokenForStatus: string | null = (preCookie || cookie || (hasAuthHeader ? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') : '')) || null;
    const tokenPayload = tokenForStatus ? await verifyToken(tokenForStatus) : null;
    if (tokenPayload?.sub) {
      const { prisma } = await import('./lib/db/prisma');
      const su = await prisma.user.findUnique({
        where: { id: String(tokenPayload.sub) },
        select: { isBanned: true, isSuspended: true, suspendReason: true, suspendedUntil: true, scheduledDeletionAt: true, deletedAt: true },
      });
      if (su?.deletedAt) {
        statusResponse = jsonResponse(allowedOrigin, {
          error: 'ACCOUNT_DELETED', deleted: true,
          message: 'Your account has been deleted.',
        }, 403);
      } else if (su?.scheduledDeletionAt) {
        const isCancel = pathname.includes('delete-account') && (method === 'DELETE' || url.searchParams.get('cancel') === '1');
        if (!isCancel) {
          statusResponse = jsonResponse(allowedOrigin, {
            error: 'ACCOUNT_DELETION_SCHEDULED', scheduled: true,
            scheduledAt: su.scheduledDeletionAt.toISOString(),
            message: `Your account is scheduled for deletion on ${new Date(su.scheduledDeletionAt).toLocaleDateString()}. Cancel to regain access.`,
          }, 403);
        }
      } else if (su?.isBanned) {
        await prisma.session.deleteMany({ where: { userId: tokenPayload.sub } }).catch(() => {});
        statusResponse = jsonResponse(allowedOrigin, {
          error: 'ACCOUNT_BANNED', banned: true,
          message: 'Your account has been permanently banned.',
        }, 403);
      } else if (su?.isSuspended) {
        if (su.suspendedUntil && new Date(su.suspendedUntil) < new Date()) {
          await prisma.user.update({
            where: { id: String(tokenPayload.sub) },
            data: { isSuspended: false, suspendReason: null, suspendedUntil: null },
          }).catch(() => {});
        } else {
          statusResponse = jsonResponse(allowedOrigin, {
            error: 'ACCOUNT_SUSPENDED', suspended: true,
            reason: su.suspendReason || 'No reason provided',
            until: su.suspendedUntil?.toISOString() || null,
            message: `Your account is suspended${su.suspendedUntil ? ` until ${new Date(su.suspendedUntil).toUTCString()}` : ''}.`,
          }, 403);
        }
      }
    }
  } catch { /* never block on guard failure */ }
}
if (statusResponse) return statusResponse;

if (hasAuthHeader) {
  const authHeader = request.headers.get('authorization') || '';
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return jsonResponse(allowedOrigin, { error: 'Invalid Authorization header format. Expected: Bearer <token>' }, 401);
  }
}

  // ── CSRF validation for cookie-authed state-changing requests ──
  if (hasCookie && STATE_METHODS.has(request.method)) {
    const isCsrfExempt = CSRF_EXEMPT_PATHS.some(p => pathname.startsWith(p)) || isPublicFormSubmit;
    if (!isCsrfExempt) {
      if (!validateCsrf(request)) {
        return jsonResponse(allowedOrigin, {
          error: 'CSRF token missing or invalid. Include X-CSRF-Token header matching __csrf cookie.',
        }, 403);
      }
    }
  }

  // ── Block check + banned/suspended check (single cached JWT verify) ──
  // Use cachedPayload from the early admin check to avoid re-verifying.
  if (hasCookie && STATE_METHODS.has(request.method) && cachedPayload?.sub) {
    try {
      const { isBlocked } = await import('./lib/captcha/service');
      const clientIp = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
      const blockStatus = await isBlocked(cachedPayload.sub, cachedPayload.sid, clientIp);
      if (blockStatus.blocked) {
        return jsonResponse(allowedOrigin, {
          error: 'Access blocked due to suspicious activity',
          blocked: true,
          rayId: blockStatus.rayId,
          reason: blockStatus.reason,
          expiresAt: blockStatus.expiresAt,
        }, 403);
      }
      // Check banned/suspended inline (cached per-user, 30s TTL, max 2000 entries)
      const _banCache: Map<string, { banned: boolean; suspended: boolean; ts: number }> = (globalThis as any).__banCheckCache || ((globalThis as any).__banCheckCache = new Map());
      const _bcKey = cachedPayload.sub;
      const _bcHit = _banCache.get(_bcKey);
      if (!_bcHit || Date.now() - _bcHit.ts > 30_000) {
        const { prisma } = await import('./lib/db/prisma');
        const user = await prisma.user.findUnique({ where: { id: cachedPayload.sub }, select: { isBanned: true, isSuspended: true } });
        const banned = !!user?.isBanned;
        const suspended = !!user?.isSuspended;
        _banCache.set(_bcKey, { banned, suspended, ts: Date.now() });
        if (_banCache.size > 2000) {
          const now = Date.now();
          for (const [k, v] of _banCache) { if (now - v.ts > 30_000) _banCache.delete(k); }
        }
        if (banned) return jsonResponse(allowedOrigin, { error: 'Account has been banned' }, 403);
        if (suspended) return jsonResponse(allowedOrigin, { error: 'Account has been suspended' }, 403);
      } else if (_bcHit.banned) {
        return jsonResponse(allowedOrigin, { error: 'Account has been banned' }, 403);
      } else if (_bcHit.suspended) {
        return jsonResponse(allowedOrigin, { error: 'Account has been suspended' }, 403);
      }
    } catch {
      // Block/ban check failed — allow request, handler will re-check
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
        if (user?.isBanned) return jsonResponse(allowedOrigin, { error: 'Account has been banned' }, 403);
        if (user?.isSuspended) return jsonResponse(allowedOrigin, { error: 'Account has been suspended' }, 403);
      }
    } catch {
      // API key verification failed — that's OK, the handler will re-check
    }
  }

  // Add rate limit headers to successful responses
  response.headers.set('X-RateLimit-Limit', String(rateResult.limit));
  response.headers.set('X-RateLimit-Remaining', String(rateResult.remaining));
  response.headers.set('X-RateLimit-Reset', String(rateResult.reset));

  return response;
}

export const config = {
  matcher: ['/api/:path*', '/auth/:path*'],
};
