import { prisma } from '@/infrastructure/db/prisma';
import { currentRequestOrigin } from '@/infrastructure/observability/requestContext';
import { NO_ORIGIN, type ChangeOrigin } from '@/shared/changeOrigin';

export {
  NO_ORIGIN,
  originFromInternalHeaders,
  originFromRequest,
  type ChangeOrigin,
} from '@/shared/changeOrigin';

/**
 * One row in the account's change record. Every write path ends up here — the
 * account API's own routes and the profile service's internal one — so a change
 * made anywhere carries the same fields the activity page reads.
 *
 * The origin is the caller's when it names one, and otherwise the request this
 * write is running inside of. See infrastructure/observability/requestContext.
 */
export async function recordChange(input: {
  userId: string;
  kind: string;
  title: string;
  detail?: string | null;
  severity?: 'info' | 'warning' | 'error' | 'critical';
  metadata?: Record<string, unknown>;
  origin?: ChangeOrigin;
}): Promise<void> {
  const origin = input.origin ?? currentRequestOrigin() ?? NO_ORIGIN;
  const metadata = {
    ...(input.metadata || {}),
    ...(origin.location ? { location: origin.location } : {}),
    ...(origin.coords ? { coords: origin.coords } : {}),
  };

  await prisma.activityEvent
    .create({
      data: {
        userId: input.userId,
        kind: input.kind,
        title: input.title,
        detail: input.detail ?? null,
        severity: input.severity || 'info',
        ipAddress: origin.ip,
        userAgent: origin.userAgent,
        metadata: metadata as never,
      },
    })
    .catch((e) => console.error('[ACTIVITY]', e?.message));
}
