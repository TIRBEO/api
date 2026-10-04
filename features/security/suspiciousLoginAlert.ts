import { prisma } from '@/infrastructure/db/prisma';
import { sendTemplateEmail } from '@/features/email/email';
import { describeDevice } from '@/features/notifications/notifications';
import { recordDeviceSeen } from '@/features/captcha/risk';
import { resolveLoginLocation } from '@/shared/geo';

/**
 * New-sign-in ("was that you?") email — sent only when a sign-in from a place
 * this account has not been before actually SUCCEEDS.
 *
 * The trigger is the suspicious path: the password handler challenges an
 * unfamiliar IP with an email OTP (authHandlers.ts:942-945), so by the time a
 * session is issued after that OTP the sign-in is precisely "the suspicious
 * one that got through." This helper is also reused by the other first-seen
 * paths (2FA-verify, OAuth login, magic link).
 *
 * NOT spamming: a phone on a mobile network gets a new IP constantly, so an
 * IP-diff alone is a terrible alert trigger. We gate on the DEVICE instead —
 * the fingerprint the repo already records on every ordinary sign-in via
 * recordDeviceSeen (features/captcha/risk.ts, `device.seen` activity events).
 * A moving IP on a known device never mails. Only a genuinely first-seen
 * device does, and once it is recorded it stops. When there is no fingerprint
 * to identify the device we cannot permanently de-dup, so a per-account
 * cooldown caps the noise at one email per window.
 */

const ALERT_KIND = 'auth.suspicious_login_alert';
// Backstop for sign-ins with no usable device fingerprint (curl, some bots):
// never mail the same account more than once per window.
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

type HeaderLike = { get(name: string): string | null };

export interface SuspiciousLoginAlertInput {
  userId: string;
  email?: string | null;
  name?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  fingerprint?: string | null;
  headers?: HeaderLike;
  method?: string;
}

/**
 * The testable decision: should we mail a new-sign-in alert for this login?
 * Pure of side effects (only reads history).
 */
export async function shouldSendSuspiciousLoginAlert(args: {
  userId: string;
  fingerprint?: string | null;
  now?: number;
}): Promise<boolean> {
  const { userId } = args;
  const fp = (args.fingerprint || '').trim();

  // Identified device: alert iff we have never seen this exact device on this
  // account. The just-happened suspicious login has NOT called recordDeviceSeen
  // yet (the password handler returned early before it), so `prior` counts only
  // earlier sign-ins — a real first-seen reads as 0.
  if (fp.length >= 16) {
    const prior = await prisma.activityEvent.count({
      where: {
        userId,
        kind: 'device.seen',
        metadata: { path: ['deviceFp'], equals: fp },
      },
    });
    return prior === 0;
  }

  // No device signal: fall back to a time cooldown so a moving IP cannot mail
  // on every sign-in.
  const since = new Date((args.now ?? Date.now()) - ALERT_COOLDOWN_MS);
  const recent = await prisma.activityEvent.count({
    where: { userId, kind: ALERT_KIND, createdAt: { gte: since } },
  });
  return recent === 0;
}

/**
 * Resolve, send, and mark a new-sign-in alert. Returns whether an email was
 * sent. Fire-and-forget by contract: a security-mail failure must never break
 * or delay a login, so everything here is swallowed.
 */
export async function sendSuspiciousLoginAlert(input: SuspiciousLoginAlertInput): Promise<boolean> {
  try {
    if (!input.email) return false;
    if (!(await shouldSendSuspiciousLoginAlert({ userId: input.userId, fingerprint: input.fingerprint }))) {
      return false;
    }

    const location = resolveLoginLocation(input.headers ?? { get: () => null });
    await sendTemplateEmail(input.email, 'suspicious_login', {
      name: input.name || input.email.split('@')[0],
      loginTime: new Date().toLocaleString(),
      device: describeDevice(input.userAgent),
      location,
      ipAddress: input.ip || 'Unknown',
    });

    // Audit + cooldown marker for the no-fingerprint path.
    await prisma.activityEvent
      .create({
        data: {
          userId: input.userId,
          kind: ALERT_KIND,
          title: 'New sign-in alert sent',
          severity: 'info',
          ipAddress: input.ip || null,
          userAgent: input.userAgent || null,
          metadata: { method: input.method || 'password', deviceFp: input.fingerprint || null, location } as never,
        },
      })
      .catch(() => {});

    // Remember the device so its next (moving-IP) sign-in is treated as known.
    await recordDeviceSeen({
      fingerprint: input.fingerprint || undefined,
      userId: input.userId,
      ip: input.ip || undefined,
      ua: input.userAgent || undefined,
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Non-blocking entry point for auth handlers. Deliberately not awaited and
 * never throws — a login must not wait on, or fail because of, this mail.
 */
export function notifySuspiciousLogin(input: SuspiciousLoginAlertInput): void {
  Promise.resolve()
    .then(() => sendSuspiciousLoginAlert(input))
    .catch(() => {});
}
