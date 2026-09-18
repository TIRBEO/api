import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';
import { ok, created, paged, apiError, parseLimit, requireCdnAccess } from '@/features/media/cdnV1';
import { WEBHOOK_EVENTS, validateWebhookUrl, newWebhookSecret } from '@/features/media/cdnWebhooks';

export const runtime = 'nodejs';

function shape(row: any) {
  return {
    id: row.id,
    name: row.name || null,
    url: row.url,
    events: Array.isArray(row.events) ? row.events : [],
    status: row.status,
    created_at: new Date(row.createdAt).getTime(),
  };
}

// GET /v1/webhooks
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const denied = requireCdnAccess(session, 'webhooks:read');
  if (denied) return denied;
  const limit = parseLimit(request.nextUrl.searchParams);
  try {
    const rows = await (prisma as any).cdnWebhook.findMany({
      where: { projectId: 'default' },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    }).catch(() => []);
    const hasMore = rows.length > limit;
    return paged(rows.slice(0, limit).map(shape), hasMore ? rows[limit - 1].id : null);
  } catch (err: any) {
    return apiError('LIST_FAILED', err?.message || 'Failed to list webhooks.', 500);
  }
}

// POST /v1/webhooks — { name?, url, events[] }
export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const denied = requireCdnAccess(session, 'webhooks:write');
  if (denied) return denied;
  try {
    const body: any = await request.json().catch(() => ({}));
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const check = validateWebhookUrl(url);
    if (!check.ok) return apiError('INVALID_URL', check.reason || 'Invalid URL.', 422);
    const events = Array.isArray(body.events) ? [...new Set(body.events.filter((e: unknown) => typeof e === 'string' && WEBHOOK_EVENTS.has(e)))] : [];
    if (events.length === 0) return apiError('INVALID_EVENTS', 'At least one valid event is required.', 422);
    const row = await (prisma as any).cdnWebhook.create({
      data: {
        projectId: 'default',
        name: typeof body.name === 'string' ? body.name.trim().slice(0, 100) : null,
        url,
        events,
        secret: newWebhookSecret(),
        status: 'active',
      },
    });
    return created({ webhook: shape(row) });
  } catch (err: any) {
    return apiError('CREATE_FAILED', err?.message || 'Failed to create webhook.', 500);
  }
}
