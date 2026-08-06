import { prisma } from '../db/prisma';
import { createHash } from 'crypto';

// Cache for captcha settings to avoid repeated DB queries
let settingsCache: { data: any; ts: number } | null = null;
const SETTINGS_CACHE_TTL = 30000; // 30 seconds

export async function getCaptchaSettingsCached(): Promise<any> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.ts < SETTINGS_CACHE_TTL) {
    return settingsCache.data;
  }
  try {
    const record = await prisma.captchaSettings.findFirst({ where: { key: 'global', isActive: true } });
    const DEFAULT_SETTINGS = {
      enabled: true, autoEnforce: true, riskEnabled: true,
      standardScore: 51, strongScore: 81, multiAccountThreshold: 3,
      easyThreshold: 2, mediumThreshold: 4, hardThreshold: 6, blockThreshold: 8,
      sessionDuration: 60, challengeExpiry: 2, maxAttemptsPerChallenge: 3,
      cooldownMinutes: 10, adminNotifyThreshold: 5,
    };
    const data = record ? { ...DEFAULT_SETTINGS, ...record.value as any } : DEFAULT_SETTINGS;
    settingsCache = { data, ts: now };
    return data;
  } catch {
    return settingsCache?.data || {
      enabled: true, autoEnforce: true, riskEnabled: true,
      standardScore: 51, strongScore: 81, multiAccountThreshold: 3,
      easyThreshold: 2, mediumThreshold: 4, hardThreshold: 6, blockThreshold: 8,
      sessionDuration: 60, challengeExpiry: 2, maxAttemptsPerChallenge: 3,
      cooldownMinutes: 10, adminNotifyThreshold: 5,
    };
  }
}

// Optimized isBlocked with single query
export async function isBlockedFast(userId?: string, sessionId?: string, ipAddress?: string): Promise<{ blocked: boolean; rayId?: string; reason?: string; expiresAt?: Date; blockedAt?: Date }> {
  try {
    const settings = await getCaptchaSettingsCached();
    if (!settings.enabled) return { blocked: false };
    const now = new Date();

    // Single query with OR conditions. Prisma rejects an empty OR array, so
    // only include the identity clause when at least one identifier exists.
    const identityOr = [
      ...(userId ? [{ userId }] : []),
      ...(sessionId ? [{ sessionId }] : []),
      ...(ipAddress ? [{ ipAddress }] : []),
    ];
    const block = await prisma.captchaBlock.findFirst({
      where: {
        AND: [
          ...(identityOr.length ? [{ OR: identityOr }] : [{ id: '__no_identity__' }]),
          { blockedAt: { lte: now } },
          { unblockedAt: null },
          { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] },
        ],
      },
      orderBy: { blockedAt: 'desc' },
    });

    if (block) {
      return { blocked: true, rayId: block.rayId, reason: block.reason, expiresAt: block.expiresAt || undefined, blockedAt: block.blockedAt || undefined };
    }
    return { blocked: false };
  } catch {
    return { blocked: false };
  }
}
