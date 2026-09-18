import { prisma } from '@/infrastructure/db/prisma';

/**
 * Compact JSON logger for all auth links/OTPs — single DB row per event,
 * minimal space (JSON) vs separate columns. Uses AuthLog (auth_logs) with
 * type + data JSON so it survives incognito and is per-user in DB.
 * Also mirrors to SecurityEvent for compatibility. Best-effort: never throws.
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
    // Primary: compact JSON in auth_logs (visible, low space)
    await (prisma as any).authLog.create({
      data: { type, data: compact as any },
    }).catch(()=>{});
    // Mirror to SecurityEvent for existing dashboards
    await prisma.securityEvent.create({
      data: {
        eventType: `auth.log:${type}`,
        severity: 'info',
        ipAddress: (data.ip as string) || null,
        userAgent: (data.ua as string) || null,
        userId: (data.userId as string) || null,
        metadata: compact as any,
      },
    }).catch(()=>{});
  } catch {}
}

// Helper to log OTP generation (hash only, never plain)
export async function logOtpJson(email: string, method: string, otpHash: string, ip?: string, extra?: Record<string, unknown>) {
  return logAuthJson('signup_otp', { email: email.toLowerCase(), method, otpHash: otpHash.slice(0, 16) + '…', ip, ...extra });
}

export async function logLinkJson(email: string, type: string, tokenJti: string, ip?: string, extra?: Record<string, unknown>) {
  return logAuthJson(type as any, { email: email.toLowerCase(), jti: tokenJti.slice(0, 8) + '…', ip, ...extra });
}
