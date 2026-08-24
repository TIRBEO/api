import { NextResponse, NextRequest } from 'next/server';
import { getBranding } from '../../../../lib/branding';
import { createTtlCache } from '../../../../lib/cache';

export const runtime = 'nodejs';

const configCache = createTtlCache<Record<string, unknown>>(30_000, 200);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const app = searchParams.get('app') || 'landing';

  const cached = configCache.get(app);
  if (cached) return NextResponse.json(cached);

  const branding = await getBranding();
  const body = { app, config: {}, branding };
  configCache.set(app, body as Record<string, unknown>);
  return NextResponse.json(body);
}
