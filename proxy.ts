import { NextResponse, NextRequest } from 'next/server';
import { checkRateLimitWithInfo } from '@/features/auth/rate-limit';
import { isSuspicious } from '@/features/auth/suspicious-activity';
import { verifyTurnstile, isTurnstileConfigured } from '@/features/auth/turnstile';
import { detectXss } from '@/features/auth/xss-scan';
import { getMaintenanceState } from '@/shared/maintenance-state';
import { generateEventId } from '@/features/users/refcode';
import { isPublicApiDoor } from '@/features/auth/publicDoors';
import { CORS_ALLOWED_HEADERS, isHostAllowed } from '@/config/app-urls';

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    // tirbeo.com (+ subdomains) + localhost-in-dev by default; any extra
    // deployment domain via CORS_ALLOWED_HOSTS. Shared with redirect targets.
    return isHostAllowed(u.hostname);
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

/**
 * Turn an edge rate-limit trip into a real, queryable activity row. The proxy
 * bundle has no direct DB/prisma access, so (like reportBlockedRequest above)
 * it self-POSTs to /api/security/log, which writes the row via logSecurityEvent.
 *
 * The display code handed to the client (`eventId`) is persisted as
 * metadata.refCode, so staff pasting "Ref: xxxx-xxxx-xxxx" into the security
 * search finds this exact row (listSecurityEvents matches metadata.refCode
 * candidates) — the transient RL code is no longer ephemeral. The row is keyed
 * by ip + action even when a request carries no account.
 */
async function reportRateLimit(request: NextRequest, opts: {
  eventId: string;
  action: string;
  ip: string;
  resetsAt: number;
}) {
  const key = process.env.SECURITY_LOG_KEY;
  if (!key) return;
  const origin = request.nextUrl.origin;
  try {
    await fetch(`${origin}/api/security/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-security-log-key': key },
      body: JSON.stringify({
        eventType: 'security.rate_limited',
        severity: 'warning',
        notifyAdmin: false,
        details: {
          reason: 'rate_limited',
          action: opts.action,
          ip: opts.ip,
          // Display code, mirrored so the reference the user sees is searchable.
          refCode: opts.eventId,
          keyHint: opts.action,
          resetsAt: new Date(opts.resetsAt).toISOString(),
          rayId: request.headers.get('cf-ray') || request.headers.get('x-vercel-id') || '',
        },
      }),
    }).catch(() => {});
  } catch {
    // Best-effort logging only
  }
}

const isDev = process.env.NODE_ENV === 'development';

// ─── Turnstile fallback budget (suspicious-IP gate) ───────────────────────
// 30 tokenless passes per hour per IP. This budget is only ever consumed by an
// IP that already reached the suspicious-IP gate below (`isSuspicious(ip)`), so
// a normal visitor never touches it — the tightened number is a ceiling for
// scripters, not a wall for people. The durable window lives in
// `security.rate_limit_windows` (consumed via db-windows, dynamically
// imported so Prisma stays out of this bundle — same contract as
// suspicious-activity.ts); if the DB is unreachable we degrade to a
// per-process memory window rather than failing open or 500-ing the edge.
const TURNSTILE_FALLBACK_MAX = 30;
const TURNSTILE_FALLBACK_WINDOW_MS = 60 * 60 * 1000;
const turnstileFallbackMemory = new Map<string, { count: number; reset: number }>();

async function turnstileFallbackBudget(ip: string): Promise<{ allowed: boolean; resetAt: number }> {
  const key = `turnstile-fallback:${ip}`;
  try {
    const m = await import('@/features/auth/db-windows');
    const w = await m.consumeWindow(key, TURNSTILE_FALLBACK_MAX, TURNSTILE_FALLBACK_WINDOW_MS);
    return { allowed: w.allowed, resetAt: w.resetAt };
  } catch {
    const now = Date.now();
    let w = turnstileFallbackMemory.get(key);
    if (!w || now > w.reset) w = { count: 0, reset: now + TURNSTILE_FALLBACK_WINDOW_MS };
    w.count++;
    turnstileFallbackMemory.set(key, w);
    return { allowed: w.count <= TURNSTILE_FALLBACK_MAX, resetAt: w.reset };
  }
}

const securityHeaders = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=(), serial=(), midi=(), sync-xhr=(), autoplay=(), display-capture=(), fullscreen=(), picture-in-picture=(), screen-wake-lock=(), clipboard-read=(), clipboard-write=()',
  'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: https://lh3.googleusercontent.com https://avatars.githubusercontent.com https://cdn.discordapp.com https://*.googleusercontent.com; font-src 'self' data:; connect-src 'self' https: wss: ${isDev ? "http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*" : ""}; frame-ancestors 'none';`,
};

function addCorsHeaders(response: NextResponse, origin: string) {
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
  response.headers.set('Access-Control-Max-Age', '86400');
  response.headers.set('Vary', 'Origin');
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

// State-changing methods that require CSRF validation for cookie-authed requests
const STATE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Paths exempt from CSRF (public auth endpoints that don't have a session yet)
const CSRF_EXEMPT_PATHS = [
  '/api/auth/login', '/api/auth/signup', '/api/auth/logout',
  '/api/auth/refresh',
  '/api/support/appeal',
  '/api/auth/email-exists', '/api/auth/username-exists',
  '/api/auth/signup-otp/request', '/api/auth/signup-otp/verify',
  '/api/auth/login-otp/request', '/api/auth/login-otp/verify',
  '/api/auth/magic-link/request', '/api/auth/magic-link/verify',
  '/api/auth/verify-2fa', '/api/auth/recovery-2fa',
  '/api/auth/password-reset/request', '/api/auth/password-reset/verify', '/api/auth/password-reset/confirm', '/api/auth/password-reset/quick-login',
  '/api/auth/email-otp/request', '/api/auth/email-otp/verify',
  '/api/auth/phone-otp/request', '/api/auth/phone-otp/verify',
  '/api/admin/login', '/api/admin/verify-2fa', '/api/admin/change-password',
  '/api/admin/passkey/options', '/api/admin/passkey/verify',
  '/api/auth/passkey/auth-options', '/api/auth/passkey/verify',
  '/api/public/', '/api/newsletter/',
  '/api/waitlist',
  '/api/feedback',
  '/auth/google', '/auth/google/callback', '/auth/github', '/auth/github/callback',
  '/auth/discord', '/auth/discord/callback',
  '/api/auth/oauth/merge',
  '/api/auth/oauth/pending', '/api/auth/oauth/complete', '/api/auth/oauth-consent', '/api/auth/oauth/consent',
  '/api/health',
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
      const jwtModule = await import('@/features/auth/jwt');
      const payload = await jwtModule.verifyToken(preCookie!);
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
  
  // Admin API key check — requires a valid ADMIN_KEY env var to match against.
  // Constant-time comparison: header values are attacker-controlled and a
  // plain === would leak the key length/prefix via timing.
  if (!isAdminUser) {
    const adminKey = request.headers.get('x-admin-key');
    const expectedKey = process.env.ADMIN_KEY || process.env.ADMIN_API_KEY;
    if (adminKey && expectedKey && adminKey.length === expectedKey.length) {
      let diff = 0;
      for (let i = 0; i < expectedKey.length; i++) diff |= adminKey.charCodeAt(i) ^ expectedKey.charCodeAt(i);
      if (diff === 0) isAdminUser = true;
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
  const skipBodyScan = isGetRequest || pathname.startsWith('/api/health') || pathname.startsWith('/api/public/') || pathname.startsWith('/api/forms/public/');
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
    // Typed event ID ("RL" family) so the user can reference this exact block.
    const rlEventId = generateEventId('ratelimit');
    const resetsAt = Date.now() + rateResult.reset * 1000;
    // Persist a real security.rate_limited row keyed by ip+action (best-effort;
    // needs SECURITY_LOG_KEY). The display code is stored as metadata.refCode so
    // "Ref: xxxx-xxxx-xxxx" the client shows is searchable in the security log.
    await reportRateLimit(request, { eventId: rlEventId, action: pathname, ip, resetsAt });
    const resp = jsonResponse(allowedOrigin, {
      error: 'Too many requests. Please try again later.',
      eventId: rlEventId,
      reset: rateResult.reset,
      resetsAt: new Date(resetsAt).toISOString(),
    }, 429);
    resp.headers.set('X-RateLimit-Limit', String(rateResult.limit));
    resp.headers.set('X-RateLimit-Remaining', '0');
    resp.headers.set('X-RateLimit-Reset', String(rateResult.reset));
    resp.headers.set('X-Event-Id', rlEventId);
    return resp;
  }

  // ── Turnstile captcha for suspicious IPs ──
  // Graceful fallback: a hard 403 on a missing token dead-ends every real user
  // whenever the widget itself cannot load (challenges.cloudflare.com blocked
  // by the visitor's network, an ad-blocker, an outage) — password resets and
  // OTP sends become unreachable. This block only runs for an IP already
  // flagged `isSuspicious(ip)`, so a normal visitor never enters it. Instead of
  // trapping even a suspicious one, requests without a passed token ride a
  // secondary budget: 30 per hour per IP (a ceiling for scripters, never a wall
  // for people), durable across instances via the DB window (dynamic import
  // keeps Prisma out of the static middleware bundle, same contract as
  // suspicious-activity.ts). The only error left on this path is a clear 429
  // once that budget is spent.
  if (!isDev && isAuth && isTurnstileConfigured() && isSuspicious(ip)) {
    const turnstileToken = request.headers.get('x-turnstile-token') || '';
    const valid = turnstileToken ? await verifyTurnstile(turnstileToken, ip) : false;
    if (!valid) {
      const budget = await turnstileFallbackBudget(ip);
      if (!budget.allowed) {
        const eventId = generateEventId('ratelimit');
        const retryAfterSec = Math.max(1, Math.ceil((budget.resetAt - Date.now()) / 1000));
        await reportRateLimit(request, { eventId, action: 'turnstile-fallback', ip, resetsAt: budget.resetAt });
        const resp = jsonResponse(allowedOrigin, {
          error: 'Too many attempts without a passed security check. Please try again in about an hour.',
          eventId,
          reset: retryAfterSec,
        }, 429);
        resp.headers.set('Retry-After', String(retryAfterSec));
        return resp;
      }
    }
  }

  // ── Public doors — no session, no CSRF (the list lives in features/auth/publicDoors) ──
const isPublicFormSubmit = /^\/api\/forms\/[^/]+\/submit\/?$/.test(pathname) && request.method === 'POST';
if (isPublicApiDoor(pathname, request.method)) return response;

// ── Internal service-to-service routes ──
// `/api/internal/*` is called by another first-party service (the profile
// app) with a shared service token instead of a browser session, so the
// cookie/Authorization gate below must not apply — otherwise the profile
// service's every read and write 401s before `internalProfileHandler` can
// check `x-internal-token`. Nothing is exposed by passing the request
// through: the handler itself proves the caller, and `x-user-id` is only
// honoured after that token matches.
const isInternalPath = pathname.startsWith('/api/internal/');
if (isInternalPath) return response;


// ── Authentication check ──
const hasAuthHeader = !!request.headers.get('authorization');
const cookie = request.cookies.get('__session')?.value;
const hasCookie = !!cookie;

// POST /api/support/appeal authenticates with ACCOUNT CREDENTIALS in the
// body (email + password) precisely so a blocked or suspended account with no
// surviving session can still file its appeal. The handler itself proves
// ownership before writing anything, so passing the request through here
// exposes nothing the caller doesn't already have to know.
const isCredentialAppeal =
  pathname.startsWith('/api/support/appeal') && request.method === 'POST';

if (!hasCookie && !hasAuthHeader && !isCredentialAppeal) {
  return jsonResponse(allowedOrigin, { error: 'Not authenticated' }, 401);
}

// ── Closed accounts: one door policy, enforced at the edge ──
// A closed account that has just proved its credentials is handed a session
// (blockedAccountResponse) so it can read its own closure in /settings. That
// session opens the doors named in features/auth/blockFacts and nothing else,
// and the refusal carries the same decision of record the sign-in handed out —
// so a door and the settings screen cannot describe the closure differently.
// This runs for the cookie and a Bearer token alike, and in front of every
// route, including the ones that live outside the dispatcher.
let closedSubject = cachedPayload?.sub ?? null;
if (!closedSubject && hasAuthHeader) {
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (bearer.startsWith('eyJ')) {
    try {
      const { verifyToken } = await import('@/features/auth/jwt');
      closedSubject = ((await verifyToken(bearer)) as { sub?: string } | null)?.sub ?? null;
    } catch { /* an unreadable token is the handler's problem, not a block */ }
  }
}
if (closedSubject) {
  try {
    const { closedAccountGate } = await import('@/features/auth/blockFacts');
    const refusal = await closedAccountGate(closedSubject, pathname, request.method);
    if (refusal) return jsonResponse(allowedOrigin, refusal, 403);
  } catch { /* a guard that cannot read the account must not block the account */ }
}

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

  // Add rate limit headers to successful responses
  response.headers.set('X-RateLimit-Limit', String(rateResult.limit));
  response.headers.set('X-RateLimit-Remaining', String(rateResult.remaining));
  response.headers.set('X-RateLimit-Reset', String(rateResult.reset));

  return response;
}

export const config = {
  matcher: ['/api/:path*', '/auth/:path*'],
};
