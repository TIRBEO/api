import { NextResponse } from 'next/server';

// Temporary diagnostic: reports — with full stack — what a prisma/redis/health
// touch does in the Vercel runtime. Remove once /api/health is green again.
export const dynamic = 'force-dynamic';

export async function GET() {
  const results: Record<string, string> = {};
  const run = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      results[name] = 'ok';
    } catch (e: any) {
      results[name] = `${e?.name || 'Error'}: ${e?.message || String(e)} :: ${(e?.stack || '').split('\n').slice(0, 4).join(' | ')}`;
    }
  };

  await run('prisma-import', async () => {
    const m = await import('@/infrastructure/db/prisma');
    return m;
  });
  await run('prisma-query', async () => {
    const { prisma } = await import('@/infrastructure/db/prisma');
    return prisma.$queryRaw`SELECT 1`;
  });
  await run('redis', async () => {
    const m = await import('@/infrastructure/db/redis');
    const c = m.getCachedRedisClient('probe', { url: process.env.REDIS_URL || '' });
    return c.ping();
  });
  await run('health-module', async () => {
    const m = await import('@/features/observability/health');
    return m.publicHealthHandler();
  });
  await run('env', () => {
    results.env = JSON.stringify({
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      hasDb: !!process.env.DATABASE_URL,
      hasRedis: !!process.env.REDIS_URL,
    });
    return Promise.resolve();
  });

  return NextResponse.json(results);
}
