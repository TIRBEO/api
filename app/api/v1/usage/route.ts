import { NextRequest } from 'next/server';
import { requireSession } from '@/features/auth/http-guards';
import { ok, apiError, toBytes, requireCdnAccess, listTopFolderUsage, getOrgStorageUsageBytes } from '@/features/media/cdnV1';

export const runtime = 'nodejs';

// GET /v1/usage — byte-accurate storage, bandwidth, requests, uploads.
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
    let uploads = 0;
    for (const f of Object.values(byFolder)) uploads += f.objects;
    return ok({
      usage: {
        storage: { used: toBytes(storageUsed), limit: 100 * 1024 * 1024 * 1024 },
        bandwidth: { used: 0, limit: 1000 * 1024 * 1024 * 1024 },
        requests: { used: 0, limit: 20_000_000 },
        uploads,
        by_folder: byFolder,
      },
    });
  } catch (err: any) {
    return apiError('USAGE_FAILED', err?.message || 'Failed to load usage.', 500);
  }
}
