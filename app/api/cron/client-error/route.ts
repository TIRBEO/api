import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Client errors are a real event-ledger row (kind 'client.error'), so they
// survive restarts and are queryable in admin. A small in-memory buffer is kept
// ONLY as a fallback for the (rare) case where the ledger write fails — it is no
// longer the source of truth.
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
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
      || req.headers.get('x-real-ip') || req.headers.get('cf-connecting-ip') || null;
    const { prisma } = await import('@/infrastructure/db/prisma');
    try {
      await prisma.activityEvent.create({
        data: {
          kind: 'client.error',
          title: 'Client error (websocket / API)',
          detail: String(entry.message || '').slice(0, 500) || null,
          severity: 'warning',
          ipAddress: ip,
          userAgent: req.headers.get('user-agent')?.slice(0, 500) ?? null,
          metadata: entry as any,
        },
      });
    } catch {
      // Ledger unavailable — keep the volatile buffer so the data isn't lost.
      buf.push(entry);
      if (buf.length > MAX_ENTRIES) buf.shift();
    }
    console.log(`[CLIENT-ERROR] wsCode=${entry.code ?? '?'} retry=${entry.retryCount ?? 0} host=${entry.host} path=${entry.url ?? entry.path ?? ''}`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}

export async function GET(request: NextRequest) {
  const { isCronAuthorized, cronUnauthorized } = await import('../_guard');
  if (!isCronAuthorized(request)) return cronUnauthorized();
  try {
    const { prisma } = await import('@/infrastructure/db/prisma');
    const rows = await prisma.activityEvent.findMany({
      where: { kind: 'client.error' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { metadata: true },
    });
    const errors = rows.map((r: any) => r.metadata ?? {}).reverse();
    return NextResponse.json({ errors });
  } catch {
    // DB read failed — serve the volatile fallback buffer.
    return NextResponse.json({ errors: buf.slice(-50).reverse() });
  }
}