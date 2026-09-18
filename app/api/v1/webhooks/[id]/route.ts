import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';
import { ok, apiError, requireCdnAccess } from '@/features/media/cdnV1';
import { WEBHOOK_EVENTS, validateWebhookUrl } from '@/features/media/cdnWebhooks';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

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

async function findHook(id: string) {
  return (prisma as any).cdnWebhook.findUnique({ where: { id: decodeURIComponent(id) } }).catch(() => null);
}

// GET /v1/webhooks/:id
export async function GET(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const denied = requireCdnAccess(session, 'webhooks:read');
  if (denied) return denied;
  const { id } = await ctx.params;
  const row = await findHook(id);
  if (!row) return apiError('WEBHOOK_NOT_FOUND', 'Webhook does not exist.', 404);
  const deliveries = await (prisma as any).cdnWebhookDelivery.findMany({
    where: { webhookId: row.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
  }).catch(() => []);
  return ok({ webhook: shape(row), recent_deliveries: deliveries });
}

// PATCH /v1/webhooks/:id — { name?, url?, events?, status? }
export async function PATCH(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const denied = requireCdnAccess(session, 'webhooks:write');
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const row = await findHook(id);
    if (!row) return apiError('WEBHOOK_NOT_FOUND', 'Webhook does not exist.', 404);
    const body: any = await request.json().catch(() => ({}));
    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string') data.name = body.name.trim().slice(0, 100) || null;
    if (typeof body.url === 'string') {
      const check = validateWebhookUrl(body.url.trim());
      if (!check.ok) return apiError('INVALID_URL', check.reason || 'Invalid URL.', 422);
      data.url = body.url.trim();
    }
    if (Array.isArray(body.events)) {
      const events = [...new Set(body.events.filter((e: unknown) => typeof e === 'string' && WEBHOOK_EVENTS.has(e)))];
      if (events.length === 0) return apiError('INVALID_EVENTS', 'At least one valid event is required.', 422);
      data.events = events;
    }
    if (body.status === 'active' || body.status === 'disabled') data.status = body.status;
    const updated = await (prisma as any).cdnWebhook.update({ where: { id: row.id }, data });
    return ok({ webhook: shape(updated) });
  } catch (err: any) {
    return apiError('UPDATE_FAILED', err?.message || 'Update failed.', 500);
  }
}

// DELETE /v1/webhooks/:id
export async function DELETE(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const denied = requireCdnAccess(session, 'webhooks:write');
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const row = await findHook(id);
    if (!row) return apiError('WEBHOOK_NOT_FOUND', 'Webhook does not exist.', 404);
    await (prisma as any).cdnWebhook.delete({ where: { id: row.id } });
    return ok({ ok: true });
  } catch (err: any) {
    return apiError('DELETE_FAILED', err?.message || 'Delete failed.', 500);
  }
}
