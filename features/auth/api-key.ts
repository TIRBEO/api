import { NextRequest } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { createHash } from 'crypto';

function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;

  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    console.warn('[API_KEY_AUTH] Invalid Authorization header format:', header.substring(0, 20) + '...');
    return null;
  }

  const token = parts[1]?.trim();
  if (!token) {
    console.warn('[API_KEY_AUTH] Empty Bearer token');
    return null;
  }
  return token;
}

export interface ApiKeyAuthResult {
  userId: string;
  keyId: string;
  scopes: string[] | null;
  /** CDN key type: `dashboard` (legacy tb_) or `cdn` (tk_live_). */
  keyType: 'dashboard' | 'cdn';
  /** CDN path scopes, e.g. [`/avatars/*`]. Null = unrestricted. */
  pathScopes: string[] | null;
  /** CDN fine-grained permissions, e.g. [`files:read`]. Null = unrestricted. */
  keyPermissions: string[] | null;
}

/** Extract CDN scoping from the key's permissions JSON (back-compat: absent = full access). */
export function cdnKeyScope(permissions: unknown): { pathScopes: string[] | null; keyPermissions: string[] | null } {
  if (!permissions || typeof permissions !== 'object') return { pathScopes: null, keyPermissions: null };
  const p = permissions as Record<string, unknown>;
  const rawPaths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string') : null;
  const rawPerms = Array.isArray(p.perms) ? p.perms.filter((x): x is string => typeof x === 'string') : null;
  // Legacy bucket-scoped keys (`buckets: [...]`) predate paths — treat as full path access.
  return { pathScopes: rawPaths, keyPermissions: rawPerms };
}

export async function authenticateApiKey(request: NextRequest): Promise<ApiKeyAuthResult | null> {
  try {
    const rawToken = extractBearerToken(request);
    if (!rawToken) return null;

    // API keys start with `tb_` (legacy dashboard) or `tk_live_` (CDN).
    // Session JWTs (sent by the dashboard as a Bearer fallback) start with
    // `eyJ` and can never match an API key, so skip the DB lookup entirely —
    // it was a wasted round trip per request.
    if (!rawToken.startsWith('tb_') && !rawToken.startsWith('tk_live_')) return null;

    const keyHash = hashApiKey(rawToken);

    const record = await prisma.apiKey.findUnique({ where: { keyHash } });
    if (!record) {
      console.warn('[API_KEY_AUTH] Key not found in database. Hash:', keyHash.substring(0, 8) + '...');
      return null;
    }

    if (!record.isActive) {
      console.warn('[API_KEY_AUTH] Key is disabled:', record.id, 'for user:', record.userId);
      return null;
    }

    // Update lastUsedAt fire-and-forget
    prisma.apiKey.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    }).catch((e: any) => console.error('[API_KEY_AUTH] Failed to update lastUsedAt:', e?.message));

    console.log('[API_KEY_AUTH] Authenticated user:', record.userId, 'key:', record.id);
    const scope = cdnKeyScope(record.permissions);
    return {
      userId: record.userId,
      keyId: record.id,
      scopes: null,
      keyType: rawToken.startsWith('tk_live_') ? 'cdn' : 'dashboard',
      pathScopes: scope.pathScopes,
      keyPermissions: scope.keyPermissions,
    };
  } catch (e: any) {
    console.error('[API_KEY_AUTH] Exception during authentication:', e?.message || e);
    return null;
  }
}
