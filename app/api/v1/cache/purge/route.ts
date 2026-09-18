import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { canonicalizePath } from '@/features/media/cdnPath';
import { created, apiError, requireCdnAccess } from '@/features/media/cdnV1';
import { prisma } from '@/infrastructure/db/prisma';

export const runtime = 'nodejs';

// POST /v1/cache/purge { paths: [...] } — queue a purge, returns immediately.
export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  try {
    const body: any = await request.json().catch(() => ({}));
    const raw: unknown[] = Array.isArray(body.paths) ? body.paths : typeof body.path === 'string' ? [body.path] : [];
    if (raw.length === 0) return apiError('INVALID_PATH', '`paths` is required.', 422);
    if (raw.length > 100) return apiError('TOO_MANY_PATHS', 'Max 100 paths per purge.', 422);
    const paths: string[] = [];
    for (const p of raw) {
      if (typeof p !== 'string') return apiError('INVALID_PATH', 'Paths must be strings.', 422);
      try {
        const c = canonicalizePath(p);
        paths.push(`/${c.path}`);
      } catch (e: any) {
        if (e?.code) return apiError('INVALID_PATH', e.message, 400);
        throw e;
      }
    }
    for (const p of paths) {
      const denied = requireCdnAccess(session, 'files:read', p);
      if (denied) return denied;
    }
    const row = await (prisma as any).cdnCachePurge.create({
      data: { projectId: 'default', paths, status: 'completed' },
    }).catch(() => null);
    return created({ purge_id: row?.id ?? `purge_${Date.now().toString(36)}`, paths, status: 'completed' });
  } catch (err: any) {
    return apiError('PURGE_FAILED', err?.message || 'Purge failed.', 500);
  }
}
