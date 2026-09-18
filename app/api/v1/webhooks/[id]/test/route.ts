import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';
import { ok, apiError, requireCdnAccess, CDN_PUBLIC_BASE } from '@/features/media/cdnV1';
import { deliverWebhook } from '@/features/media/cdnWebhooks';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

// POST /v1/webhooks/:id/test — sends a ping event synchronously.
export async function POST(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const denied = requireCdnAccess(session, 'webhooks:write');
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const row = await (prisma as any).cdnWebhook.findUnique({ where: { id: decodeURIComponent(id) } }).catch(() => null);
    if (!row) return apiError('WEBHOOK_NOT_FOUND', 'Webhook does not exist.', 404);
    await deliverWebhook(row.id, 'file.uploaded', { ping: true, base: CDN_PUBLIC_BASE, at: Date.now() });
    const last = await (prisma as any).cdnWebhookDelivery.findFirst({
      where: { webhookId: row.id },
      orderBy: { createdAt: 'desc' },
    }).catch(() => null);
    return ok({ ok: true, delivery: last ? { status: last.status, attempts: last.attempts, last_status: last.lastStatus } : null });
  } catch (err: any) {
    return apiError('TEST_FAILED', err?.message || 'Test failed.', 500);
  }
}
