import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';
import { normalizeScope } from '@/features/media/cdnPath';
import { ok, apiError } from '@/features/media/cdnV1';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

function isKeySession(session: unknown): boolean {
  return !!(session as { sessionId?: string }).sessionId?.startsWith('apikey:');
}

async function ownedKey(userId: string, id: string) {
  return prisma.apiKey.findFirst({ where: { id: decodeURIComponent(id), userId } });
}

// GET /v1/api-keys/:id
export async function GET(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  if (isKeySession(session)) return apiError('FORBIDDEN', 'API keys cannot manage API keys.', 403);
  const { id } = await ctx.params;
  const row = await ownedKey(session.userId, id).catch(() => null);
  if (!row) return apiError('KEY_NOT_FOUND', 'API key does not exist.', 404);
  const perms = (row.permissions ?? {}) as Record<string, unknown>;
  return ok({
    key: {
      id: row.id,
      name: row.name,
      prefix: row.keyPrefix,
      paths: Array.isArray(perms.paths) ? perms.paths : ['/*'],
      permissions: Array.isArray(perms.perms) ? perms.perms : [],
      expires_at: row.expiresAt ? new Date(row.expiresAt).getTime() : null,
      last_used_at: row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : null,
      is_active: row.isActive !== false,
      created_at: new Date(row.createdAt).getTime(),
    },
  });
}

// PATCH /v1/api-keys/:id — { name?, is_active? }
export async function PATCH(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  if (isKeySession(session)) return apiError('FORBIDDEN', 'API keys cannot manage API keys.', 403);
  const { id } = await ctx.params;
  try {
    const row = await ownedKey(session.userId, id);
    if (!row) return apiError('KEY_NOT_FOUND', 'API key does not exist.', 404);
    const body: any = await request.json().catch(() => ({}));
    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 100);
    if (typeof body.is_active === 'boolean') data.isActive = body.is_active;
    if (Array.isArray(body.paths)) {
      const perms = { ...((row.permissions ?? {}) as Record<string, unknown>) };
      perms.paths = [...new Set(body.paths.map((p: unknown) => normalizeScope(String(p ?? ''))))].slice(0, 20);
      data.permissions = perms;
    }
    const updated = await prisma.apiKey.update({ where: { id: row.id }, data });
    return ok({ key: { id: updated.id, name: updated.name, is_active: updated.isActive } });
  } catch (err: any) {
    return apiError('UPDATE_FAILED', err?.message || 'Update failed.', 500);
  }
}

// DELETE /v1/api-keys/:id — revoke.
export async function DELETE(request: NextRequest, ctx: Ctx) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  if (isKeySession(session)) return apiError('FORBIDDEN', 'API keys cannot manage API keys.', 403);
  const { id } = await ctx.params;
  try {
    const row = await ownedKey(session.userId, id);
    if (!row) return apiError('KEY_NOT_FOUND', 'API key does not exist.', 404);
    await prisma.apiKey.update({ where: { id: row.id }, data: { isActive: false, revokedAt: new Date() } });
    return ok({ ok: true });
  } catch (err: any) {
    return apiError('REVOKE_FAILED', err?.message || 'Revoke failed.', 500);
  }
}
