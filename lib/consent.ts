import { prisma } from './db/prisma';

/**
 * Server-side consent verification.
 * Check user's data preferences before sending analytics, crash reports, or tracking events.
 *
 * Usage:
 *   const allowed = await hasConsent(userId, 'analytics');
 *   if (allowed) { /* send event *\/ }
 */

type ConsentType = 'analytics' | 'crashReports';

const CONSENT_MAP: Record<ConsentType, string> = {
  analytics: 'allowAnalytics',
  crashReports: 'allowCrashReports',
};

const DEFAULTS: Record<ConsentType, boolean> = {
  analytics: false,     // opt-in: default OFF
  crashReports: true,   // opt-out: default ON
};

/**
 * Check if a user has given consent for a specific data type.
 * Reads directly from the database (per-user, per-request).
 */
export async function hasConsent(userId: string, type: ConsentType): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { consents: true },
    });

    if (!user) return DEFAULTS[type];

    const consents = (user as any).consents as Record<string, unknown> | null;
    const key = CONSENT_MAP[type];

    if (consents && typeof consents === 'object' && key in consents) {
      return consents[key] === true;
    }

    return DEFAULTS[type];
  } catch {
    return DEFAULTS[type];
  }
}

/**
 * Check multiple consent types at once (single DB query).
 */
export async function hasConsents(
  userId: string,
  types: ConsentType[]
): Promise<Record<ConsentType, boolean>> {
  const result: Record<string, boolean> = {};

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { consents: true },
    });

    const consents = (user as any)?.consents as Record<string, unknown> | null;

    for (const type of types) {
      const key = CONSENT_MAP[type];
      if (consents && typeof consents === 'object' && key in consents) {
        result[type] = consents[key] === true;
      } else {
        result[type] = DEFAULTS[type];
      }
    }
  } catch {
    for (const type of types) {
      result[type] = DEFAULTS[type];
    }
  }

  return result as Record<ConsentType, boolean>;
}

/**
 * Batch check: get all user IDs who have consented to a specific type.
 * Used for admin analytics to only include opted-in users.
 */
export async function getUsersWithConsent(type: ConsentType): Promise<string[]> {
  const key = CONSENT_MAP[type];

  try {
    const users = await prisma.user.findMany({
      where: {
        consents: { path: [key], equals: true },
        deletedAt: null,
      },
      select: { id: true },
    });

    return users.map((u) => u.id);
  } catch {
    return [];
  }
}
