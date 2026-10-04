import { prisma } from '@/infrastructure/db/prisma';

/**
 * Compact JSON logger for all auth links/OTPs — single DB row per event.
 * activity_events is the ONLY event log in the consolidated schema (auth_logs
 * and security_events were removed: they duplicated this shape). Secrets are
 * never stored — OTP hashes are truncated and links are logged by jti only.
 * Best-effort.
 */
export async function logAuthJson(
  type: 'signup_otp' | 'login_otp' | 'magic_link' | 'password_reset_otp' | 'password_reset_link' | 'password_recovery_otp' | 'verify' | 'other',
  data: Record<string, unknown>
): Promise<void> {
  try {
    const compact: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined && v !== null && v !== '') compact[k] = v;
    }
    compact._t = Date.now();
    // activity_events.user_id has a NOT-NULL FK to users(id). Pre-account auth
    // events (signup-otp, login-otp, magic-link) have no user yet, so there is
    // nothing attributable — skip the DB write instead of violating the FK.
    const userId = typeof data.userId === 'string' && data.userId ? data.userId : null;
    if (!userId) return;
    await prisma.activityEvent.create({
      data: {
        userId,
        kind: `auth.log:${type}`,
        title: `Auth event: ${type}`,
        detail: (data.email as string) || null,
        severity: 'info',
        ipAddress: (data.ip as string) || null,
        userAgent: (data.ua as string) || null,
        metadata: compact as any,
      },
    }).catch(() => {});
  } catch {}
}

// Helper to log OTP generation (hash only, never plain)
export async function logOtpJson(email: string, method: string, otpHash: string, ip?: string, extra?: Record<string, unknown>) {
  return logAuthJson('signup_otp', { email: email.toLowerCase(), method, otpHash: otpHash.slice(0, 16) + '…', ip, ...extra });
}

export async function logLinkJson(email: string, type: string, tokenJti: string, ip?: string, extra?: Record<string, unknown>) {
  return logAuthJson(type as any, { email: email.toLowerCase(), jti: tokenJti.slice(0, 8) + '…', ip, ...extra });
}
