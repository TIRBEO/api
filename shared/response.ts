import { NextRequest, NextResponse } from 'next/server';
import { CORS_ALLOWED_HEADERS, isHostAllowed } from '@/config/app-urls';

export function addCorsToResponse(res: NextResponse, request?: NextRequest) {
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
    // Same allowlist proxy.ts uses — the hardcoded list here drifted from it
    // (missed alternate domains, and let any localhost through in production).
    if (isHostAllowed(u.hostname)) {
      res.headers.set('Access-Control-Allow-Origin', origin);
      res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.headers.set('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
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

/**
 * "We could not tell whether you are signed in" — the database did not answer
 * the session lookup. Deliberately NOT a 401: clients read a 401 as a dead
 * credential and sign the user out of a session that is still alive, whereas a
 * 503 is read as a transient outage and retried.
 */
export function jsonSessionUnavailable(request?: NextRequest) {
  return addCorsToResponse(
    NextResponse.json(
      { error: 'We could not check your session just now. Please try again in a moment.', code: 'SESSION_LOOKUP_UNAVAILABLE' },
      { status: 503, headers: { 'Retry-After': '5' } },
    ),
    request,
  );
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
