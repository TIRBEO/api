import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// In-memory ring buffer for last 200 client errors (GET requires auth)
const g = globalThis as any;
if (!g.__tirbeoClientErrors) g.__tirbeoClientErrors = [] as any[];
const buf: any[] = g.__tirbeoClientErrors;

const MAX_ENTRIES = 200;
const MAX_VALUE_LEN = 500;
const ALLOWED_FIELDS = ['code', 'retryCount', 'url', 'wsHost', 'message', 'path'] as const;

function sanitizeEntry(body: unknown, req: NextRequest): Record<string, any> {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  const entry: Record<string, any> = {};
  for (const key of ALLOWED_FIELDS) {
    const v = src[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') entry[key] = String(v).slice(0, MAX_VALUE_LEN);
    else if (typeof v === 'number' && Number.isFinite(v)) entry[key] = v;
  }
  entry.host = req.headers.get('host') || '';
  entry.at = new Date().toISOString();
  return entry;
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json().catch(() => ({}));
    const entry = sanitizeEntry(raw, req);
    // Cap the raw payload size server-side against oversized floods.
    if (JSON.stringify(entry).length > 16 * 1024) {
      return NextResponse.json({ ok: true });
    }
    buf.push(entry);
    if (buf.length > MAX_ENTRIES) buf.shift();
    console.log(`[CLIENT-ERROR] wsCode=${entry.code ?? '?'} retry=${entry.retryCount ?? 0} host=${entry.host} path=${entry.url ?? entry.path ?? ''}`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}

export async function GET(request: NextRequest) {
  const { isCronAuthorized, cronUnauthorized } = await import('../_guard');
  if (!isCronAuthorized(request)) return cronUnauthorized();
  return NextResponse.json({ errors: buf.slice(-50).reverse() });
}