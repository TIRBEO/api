import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const config = await prisma.siteConfig.findUnique({ where: { app: 'landing' } });
    return NextResponse.json(config?.config || {}, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch {
    return NextResponse.json({}, { status: 200 });
  }
}
