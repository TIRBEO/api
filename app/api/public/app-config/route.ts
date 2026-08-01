import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { getBranding } from '../../../../lib/branding';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const app = searchParams.get('app') || 'landing';

  try {
    const record = await prisma.siteConfig.findUnique({ where: { app } });
    const config = record?.config || {};
    const branding = await getBranding();

    return NextResponse.json({
      app,
      config,
      branding,
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch {
    const branding = await getBranding();
    return NextResponse.json({ app, config: {}, branding });
  }
}
