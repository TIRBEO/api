import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { ok, apiError, toBytes, requireCdnAccess, listTopFolderUsage, getOrgStorageUsageBytes } from '@/features/media/cdnV1';

export const runtime = 'nodejs';

// GET /v1/usage/storage — storage used/limit + per-top-level-folder breakdown.
export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (session instanceof Response) return session;
  const denied = requireCdnAccess(session, 'usage:read');
  if (denied) return denied;
  try {
    const [byFolder, storageUsed] = await Promise.all([
      listTopFolderUsage().catch(() => ({} as Record<string, { storage: number; objects: number }>)),
      getOrgStorageUsageBytes().catch(() => 0),
    ]);
    return ok({ storage: { used: toBytes(storageUsed), limit: 100 * 1024 * 1024 * 1024, by_folder: byFolder } });
  } catch (err: any) {
    return apiError('USAGE_FAILED', err?.message || 'Failed to load storage usage.', 500);
  }
}
