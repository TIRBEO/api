/**
 * Email Brain — Admin reporting handlers (requireAdmin-guarded).
 * Content/definition mutation handlers live in contentAdmin.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requireAdmin } from '@/features/auth/http-guards';
import { syncRegistry, detectGaps } from '@/features/email-brain/registry';

const OK = (data: unknown, status = 200) => NextResponse.json(data, { status });

export async function emailBrainOverviewHandler(request: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [emailsToday, deliveredToday, failedToday, suppressedToday, deadJobs, pendingJobs, aiAgg, gaps] =
    await Promise.all([
      prisma.email_jobs.count({ where: { createdAt: { gte: since24h } } }),
      prisma.email_deliveries.count({ where: { createdAt: { gte: since24h }, status: 'sent' } }),
      prisma.email_deliveries.count({ where: { createdAt: { gte: since24h }, status: 'failed' } }),
      prisma.email_suppressions.count({ where: { createdAt: { gte: since24h } } }),
      prisma.email_jobs.count({ where: { status: 'dead' } }),
      prisma.email_jobs.count({ where: { status: 'queued' } }),
      prisma.ai_generations.aggregate({
        where: { createdAt: { gte: since30d } },
        _count: { id: true },
        _sum: { costEstimate: true },
      }),
      detectGaps(),
    ]);

  const [cachedCount, digestCounts] = await Promise.all([
    prisma.ai_generations.count({ where: { createdAt: { gte: since30d }, cached: true } }),
    prisma.email_digests.groupBy({ by: ['cadence'], _count: { id: true } }),
  ]);

  return OK({
    emailsToday,
    deliveredToday,
    failedToday,
    suppressedToday,
    deadJobs,
    pendingJobs,
    ai: {
      generations30d: aiAgg._count.id,
      cached30d: cachedCount,
      costEstimate30d: aiAgg._sum.costEstimate ?? 0,
    },
    digestCounts: Object.fromEntries(digestCounts.map((d) => [d.cadence, d._count.id])),
    gaps: gaps.filter((g) => g.severity !== 'ok'),
  });
}

export async function emailBrainEventsHandler(request: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  if (request.method === 'POST') {
    // Sync code registry into DB (admin action, e.g. after a deploy).
    const result = await syncRegistry();
    return OK(result);
  }

  const [events, definitions, gaps] = await Promise.all([
    prisma.email_events.findMany({ orderBy: { eventKey: 'asc' } }),
    prisma.email_definitions.findMany({
      where: { status: { in: ['active', 'approved'] } },
      select: { eventKey: true, status: true, activeVersionId: true },
    }),
    detectGaps(),
  ]);
  const coverage = new Map(definitions.map((d) => [d.eventKey, d.status]));
  const gapMap = new Map(gaps.map((g) => [g.eventKey, g]));

  return OK({
    events: events.map((e) => ({
      ...e,
      coverage: coverage.get(e.eventKey) || null,
      gap: gapMap.get(e.eventKey) || null,
    })),
  });
}

export async function emailBrainDigestsHandler(request: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const [runs, pending] = await Promise.all([
    prisma.email_digests.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.email_digest_items.groupBy({ by: ['category'], _count: { id: true }, where: { consumed: false } }),
  ]);
  return OK({ runs, pending });
}

export async function emailBrainSuppressionsHandler(request: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const rows = await prisma.email_suppressions.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return OK({ suppressions: rows });
}

export async function emailBrainAiUsageHandler(request: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [byTask, recent] = await Promise.all([
    prisma.ai_generations.groupBy({
      by: ['task'],
      where: { createdAt: { gte: since30d } },
      _count: { id: true },
      _sum: { costEstimate: true, inputTokens: true, outputTokens: true },
    }),
    prisma.ai_generations.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  return OK({ byTask, recent });
}
