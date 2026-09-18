import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { prisma } from '@/infrastructure/db/prisma';
import { normalizeScope } from '@/features/media/cdnPath';
import { ok, created, paged, apiError, parseLimit } from '@/features/media/cdnV1';
import { createHash, randomUUID } from 'node:crypto';

export const runtime = 'nodejs';

const VALID_PERMS = new Set([
  'files:read', 'files:write', 'files:delete',
  'folders:read', 'folders:write', 'folders:delete',
  'uploads:create', 'signed_urls:create',
  'domains:read', 'domains:write',
  'webhooks:read', 'webhooks:write',
  'usage:read',
]);

function publicKey(row: any) {
  const perms = (row.permissions ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    name: row.name,
    prefix: row.keyPrefix,
    paths: Array.isArray(perms.paths) ? perms.paths : ['/*'],
    permissions: Array.isArray(perms.perms) ? perms.perms : [],
    expires_at: row.expiresAt ? new Date(row.expiresAt).getTime() : null,
    last_used_at: row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : null,
    is_active: row.isActive !== false,
    created_at: new Date(row.createdAt).getTime(),
  };
}

// GET /v1/api-keys — dashboard-session only (keys manage keys).
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  if ((session as { sessionId?: string }).sessionId?.startsWith('apikey:')) {
    return apiError('FORBIDDEN', 'API keys cannot manage API keys.', 403);
  }
  const limit = parseLimit(request.nextUrl.searchParams);
  try {
    const rows = await prisma.apiKey.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    return paged(rows.slice(0, limit).map(publicKey), hasMore ? rows[limit - 1].id : null);
  } catch (err: any) {
    return apiError('LIST_FAILED', err?.message || 'Failed to list keys.', 500);
  }
}

// POST /v1/api-keys — { name, path?, paths?, permissions?, expires_in? }
export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  if ((session as { sessionId?: string }).sessionId?.startsWith('apikey:')) {
    return apiError('FORBIDDEN', 'API keys cannot manage API keys.', 403);
  }
  try {
    const body: any = await request.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
    if (!name) return apiError('INVALID_NAME', '`name` is required.', 422);

    const rawPaths: string[] = Array.isArray(body.paths)
      ? body.paths
      : typeof body.path === 'string'
        ? [body.path]
        : ['/*'];
    const paths = [...new Set(rawPaths.map((p) => normalizeScope(p)))].slice(0, 20);

    const rawPerms: string[] = Array.isArray(body.permissions) ? body.permissions : ['files:read', 'files:write'];
    const permissions = [...new Set(rawPerms.filter((p) => VALID_PERMS.has(p)))];
    if (permissions.length === 0) return apiError('INVALID_PERMISSIONS', 'At least one valid permission is required.', 422);

    const expiresIn = Math.floor(Number(body.expires_in) || 0);
    const secret = `tk_live_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const keyHash = createHash('sha256').update(secret).digest('hex');
    const row = await prisma.apiKey.create({
      data: {
        userId: session.userId,
        name,
        keyHash,
        keyPrefix: secret.slice(0, 12),
        permissions: { type: 'cdn', paths, perms: permissions },
        isActive: true,
        expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
      },
    });
    // Secret shown exactly once — never stored raw.
    return created({ key: publicKey(row), secret });
  } catch (err: any) {
    return apiError('CREATE_FAILED', err?.message || 'Failed to create key.', 500);
  }
}
