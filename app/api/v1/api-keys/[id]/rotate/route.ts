import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';
import { created, apiError } from '@/features/media/cdnV1';
import { createHash, randomUUID } from 'node:crypto';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

// POST /v1/api-keys/:id/rotate — new secret, same scope. Old secret dies immediately.
export async function POST(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  if ((session as { sessionId?: string }).sessionId?.startsWith('apikey:')) {
    return apiError('FORBIDDEN', 'API keys cannot manage API keys.', 403);
  }
  const { id } = await ctx.params;
  try {
    const row = await prisma.apiKey.findFirst({ where: { id: decodeURIComponent(id), userId: session.userId } });
    if (!row) return apiError('KEY_NOT_FOUND', 'API key does not exist.', 404);
    const secret = `tk_live_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const updated = await prisma.apiKey.update({
      where: { id: row.id },
      data: { keyHash: createHash('sha256').update(secret).digest('hex'), keyPrefix: secret.slice(0, 12), lastUsedAt: null },
    });
    return created({ key: { id: updated.id, name: updated.name, prefix: updated.keyPrefix }, secret });
  } catch (err: any) {
    return apiError('ROTATE_FAILED', err?.message || 'Rotate failed.', 500);
  }
}
