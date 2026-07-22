import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { cachedJson } from '../../../../lib/response';

export async function GET(request: NextRequest) {
  const config = await prisma.siteConfig.findUnique({ where: { app: 'landing' } });
  return cachedJson(config?.config || {}, { ttl: 30, swr: 300 });
}