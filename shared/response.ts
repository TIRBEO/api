import { NextRequest, NextResponse } from 'next/server';

function addCorsToResponse(res: NextResponse, request?: NextRequest) {
  if (!request) {
    res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return res;
  }
  const origin = request.headers.get('origin') || '';
  if (!origin) return res;
  try {
    const u = new URL(origin);
    if (['localhost', '127.0.0.1'].includes(u.hostname) || u.hostname.endsWith('.tirbeo.app') || u.hostname === 'api-tirbeo.vercel.app') {
      res.headers.set('Access-Control-Allow-Origin', origin);
      res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-CSRF-Token, x-turnstile-token');
      res.headers.set('Access-Control-Allow-Credentials', 'true');
    }
  } catch {}
  return res;
}

export function cachedJson(data: unknown, init?: { status?: number; ttl?: number; swr?: number }) {
  const ttl = init?.ttl ?? 10;
  const swr = init?.swr ?? 60;
  return NextResponse.json(data, {
    status: init?.status,
    headers: {
      'Cache-Control': `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
    },
  });
}

export function jsonError(error: string, statusOrMessage?: number | string, statusOrRequest?: number | NextRequest, request?: NextRequest) {
  let message = error;
  let status = 400;
  let req = request;
  if (typeof statusOrMessage === 'number') {
    status = statusOrMessage;
    if (statusOrRequest instanceof NextRequest) req = statusOrRequest;
  } else if (typeof statusOrMessage === 'string') {
    message = statusOrMessage;
    if (typeof statusOrRequest === 'number') status = statusOrRequest;
    else if (statusOrRequest instanceof NextRequest) req = statusOrRequest;
  }
  return addCorsToResponse(NextResponse.json({ error: message, code: error }, { status }), req);
}

export function jsonSuccess(data: unknown, status: number = 200, request?: NextRequest) {
  return addCorsToResponse(NextResponse.json(data, { status }), request);
}

export function jsonUnauthorized(reason?: string, request?: NextRequest) {
  const message = reason || 'Authentication required. Provide a valid session cookie or Authorization: Bearer <api_key> header.';
  return addCorsToResponse(NextResponse.json({ error: message }, { status: 401 }), request);
}

export function jsonForbidden(reason?: string, request?: NextRequest) {
  return addCorsToResponse(NextResponse.json({ error: reason || 'Forbidden' }, { status: 403 }), request);
}

export function jsonNotFound(resource?: string, request?: NextRequest) {
  return addCorsToResponse(NextResponse.json({ error: `${resource || 'Resource'} not found` }, { status: 404 }), request);
}

export function jsonInternalError(detail?: string, request?: NextRequest) {
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : `Internal server error: ${detail || 'unknown'}`;
  return addCorsToResponse(NextResponse.json({ error: message }, { status: 500 }), request);
}

export function jsonTooManyRequests(reason?: string, request?: NextRequest) {
  return addCorsToResponse(
    NextResponse.json(
      { error: reason || 'Too many requests. Please try again later.' },
      { status: 429 }
    ),
    request
  );
}
