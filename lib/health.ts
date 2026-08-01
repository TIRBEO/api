import { NextRequest, NextResponse } from 'next/server';
import { prisma } from './db/prisma';
import { getSession } from './session';
import { jsonUnauthorized, jsonForbidden } from './response';

function isAdmin(user: any): boolean {
  return user?.adminRole != null && ['super_admin', 'admin'].includes(user.adminRole);
}

export async function publicHealthHandler() {
  const checks: Record<string, string> = {};
  let healthy = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
    healthy = false;
  }

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const { default: Redis } = await import('ioredis');
      const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await redis.connect();
      await redis.ping();
      checks.redis = 'ok';
      await redis.disconnect();
    } catch {
      checks.redis = 'error';
      healthy = false;
    }
  } else {
    checks.redis = 'not-configured';
  }

  return NextResponse.json({
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
  });
}

export async function detailedHealthHandler(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return jsonUnauthorized();
  if (!isAdmin(user)) return jsonForbidden();

  const checks: Record<string, any> = {};
  let healthy = true;

  try {
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'ok', latencyMs: Date.now() - dbStart };
  } catch (e: any) {
    checks.database = { status: 'error', error: e?.message };
    healthy = false;
  }

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const { default: Redis } = await import('ioredis');
      const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      const redisStart = Date.now();
      await redis.connect();
      await redis.ping();
      checks.redis = { status: 'ok', latencyMs: Date.now() - redisStart };
      await redis.disconnect();
    } catch (e: any) {
      checks.redis = { status: 'error', error: e?.message };
      healthy = false;
    }
  } else {
    checks.redis = { status: 'not-configured' };
  }

  try {
    const [pendingJobs, failedJobs, serviceCount] = await Promise.all([
      prisma.jobs.count({ where: { status: 'pending' } }),
      prisma.jobs.count({ where: { status: 'failed' } }),
      prisma.system_services.count(),
    ]);
    checks.queue = { pendingJobs, failedJobs };
    checks.services = { count: serviceCount };
  } catch (e: any) {
    checks.queue = { status: 'error', error: e?.message };
    healthy = false;
  }

  const [recentIncidents, recentLogs] = await Promise.all([
    prisma.incidents.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: 'desc' }, take: 5 }),
    prisma.log.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);

  return NextResponse.json({
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || 'development',
    version: process.env.npm_package_version || '0.0.1',
    checks,
    incidents: recentIncidents,
    recentRequests: recentLogs,
  });
}
