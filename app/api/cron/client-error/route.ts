import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// In-memory ring buffer for last 200 client errors (viewable via GET)
const g = globalThis as any;
if (!g.__tirbeoClientErrors) g.__tirbeoClientErrors = [] as any[];
const buf: any[] = g.__tirbeoClientErrors;

export async function POST(req: NextRequest) {
  try {
    const body: any = await req.json().catch(() => ({}));
    const entry: Record<string, any> = { ...body as Record<string, any>, ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || '', ua: req.headers.get('user-agent') || '', at: new Date().toISOString() };
    buf.push(entry);
    if (buf.length > 200) buf.shift();
    // Silent log — no PII beyond host/code
    console.log(`[CLIENT-ERROR] wsCode=${entry.code} retry=${entry.retryCount} host=${entry.wsHost} path=${entry.url}`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}

export async function GET() {
  return NextResponse.json({ errors: buf.slice(-50).reverse() });
}
