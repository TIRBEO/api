import { NextResponse, NextRequest } from 'next/server';
import { checkRateLimit } from './lib/auth/rate-limit';

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (['localhost', '127.0.0.1'].includes(u.hostname)) return true;
    if (u.hostname === 'api.tirbeo.app') return true;
    if (u.hostname.endsWith('.tirbeo.app')) return true;
    // Only allow specific Vercel deployments
    if (u.hostname === 'api-tirbeo.vercel.app') return true;
    return false;
  } catch {
    return false;
  }
}

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; form-action 'self';",
};

function addCorsHeaders(response: NextResponse, origin: string) {
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Max-Age', '86400');
}

export async function middleware(request: NextRequest) {
  const origin = request.headers.get('origin') || '';
  const corsOk = isAllowedOrigin(origin);

  if (request.method === 'OPTIONS' && corsOk) {
    const preflightResponse = new NextResponse(null, { status: 204 });
    addCorsHeaders(preflightResponse, origin);
    return preflightResponse;
  }

  const response = NextResponse.next();
  Object.entries(securityHeaders).forEach(([k, v]) => response.headers.set(k, v));

  if (corsOk) {
    addCorsHeaders(response, origin);
  }

  const ip = request.headers.get('x-forwarded-for') || '' || 'unknown';
  const pathname = request.nextUrl.pathname;

  const isAuth = pathname.startsWith('/api/auth/login') || pathname.startsWith('/api/auth/signup') || pathname.startsWith('/api/auth/verify-2fa') || pathname.startsWith('/api/auth/recovery-2fa') || pathname.startsWith('/api/auth/login-otp') || pathname.startsWith('/api/auth/password-reset');
  const rateOk = await checkRateLimit(`${ip}:${pathname}`, isAuth);
  if (!rateOk) {
    return new NextResponse('Too many requests', { status: 429 });
  }

  const publicPaths = [
    '/api/auth/login', '/api/auth/signup', '/api/auth/logout',
    '/api/auth/signup-otp/request', '/api/auth/login-otp/request', '/api/auth/login-otp/verify',
    '/api/auth/magic-link/request', '/api/auth/magic-link/verify',
    '/api/auth/verify-2fa', '/api/auth/recovery-2fa',
    '/api/auth/google', '/api/auth/google/callback', '/api/auth/github', '/api/auth/github/callback',
    '/api/auth/password-reset/request', '/api/auth/password-reset/verify', '/api/auth/password-reset/confirm',
    '/api/auth/email-otp/request', '/api/auth/email-otp/verify',
    '/api/auth/phone-otp/request', '/api/auth/phone-otp/verify',
    '/api/admin/login', '/api/admin/seed', '/api/admin/check-setup',
    '/api/public/', '/api/newsletter/',
  ];
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !publicPaths.some(p => pathname.startsWith(p))) {
    const cookie = request.cookies.get('__session')?.value;
    if (!cookie) {
      return new NextResponse('Missing authentication cookie', { status: 403 });
    }
    // Check if user is banned (lazy import to avoid circular deps)
    try {
      const { verifyToken } = await import('./lib/auth/jwt');
      const payload = await verifyToken(cookie);
      if (payload?.sub) {
        const { prisma } = await import('./lib/db/prisma');
        const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isBanned: true, isSuspended: true } });
        if (user?.isBanned) {
          return new NextResponse('Account has been banned', { status: 403 });
        }
        if (user?.isSuspended) {
          return new NextResponse('Account has been suspended', { status: 403 });
        }
      }
    } catch {
      // If token verification fails, let the route handler deal with it
    }
  }

  return response;
}

export const config = {
  matcher: ['/api/:path*', '/auth/:path*'],
};
