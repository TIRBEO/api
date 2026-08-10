import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { getBranding } from '../../../../lib/branding';
import { createTtlCache } from '../../../../lib/cache';

export const runtime = 'nodejs';

// Site config + branding are read on every app page load. Cache in-memory;
// config changes propagate within the TTL and getBranding has its own cache.
const configCache = createTtlCache<Record<string, unknown>>(30_000, 200);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const app = searchParams.get('app') || 'landing';

  const cached = configCache.get(app);
  if (cached) return NextResponse.json(cached);

  try {
    const record = await prisma.siteConfig.findUnique({ where: { app } });
    const config = record?.config || {};
    const branding = await getBranding();

    const body = {
      app,
      config,
      branding,
    };

    configCache.set(app, body as Record<string, unknown>);
    return NextResponse.json(body);
  } catch {
    const branding = await getBranding();
    const body = { app, config: {}, branding };
    configCache.set(app, body as Record<string, unknown>);
    return NextResponse.json(body);
  }
}
