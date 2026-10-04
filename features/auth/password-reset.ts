import { prisma } from '@/infrastructure/db/prisma';
import { hashOtpCode, verifyOtpCode } from '@/features/auth/password';
import { signPasswordResetToken, verifyPasswordResetToken } from '@/features/auth/jwt';
import { addMinutes } from 'date-fns';
import { randomInt } from 'crypto';
import { enforceResendCooldown } from '@/features/auth/resend-cooldown';
import { getAccountsBaseUrl } from '@/config/app-urls';
import { fetchLoginUserByEmail, fetchLoginUserById } from '@/features/identity/tirbeo';
import { verifiedRecoveryAddress } from '@/features/auth/recovery-email';
import { eventIdFor } from '@/features/users/refcode';

const RESET_TTL_MINUTES = 15;
const MAX_OTP_ATTEMPTS = 5;
const RESET_OTP_KIND = 'email';

/**
 * Fetch the latest live reset OTP for a user, enforcing the
 * 5-attempt cap (mirrors signup-otp.ts). A code that has been guessed wrong
 * MAX_OTP_ATTEMPTS times is invalidated so a fresh code is required.
 */
async function findLiveResetOtp(userId: string) {
  const otp = await prisma.otp.findFirst({
    where: { userId, kind: RESET_OTP_KIND },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) return null;
  if (otp.expiresAt < new Date()) {
    await prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
    return null;
  }
  if ((otp.attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
    await prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
    return null;
  }
  return otp;
}

/** Register a failed guess; invalidates the code once the cap is hit. */
async function registerResetFailedAttempt(otpId: string, attempts: number) {
  const next = (attempts ?? 0) + 1;
  if (next >= MAX_OTP_ATTEMPTS) {
    await prisma.otp.delete({ where: { id: otpId } }).catch(() => {});
  } else {
    await prisma.otp.update({ where: { id: otpId }, data: { attempts: next } }).catch(() => {});
  }
}

/**
 * Shared send helper — routes through the Email Brain decision engine.
 * Security-critical values (OTP code, reset URL) go into the Redis secure
 * store, never into the DB job payload. Returns false when the value could
 * not be secured (Redis down) — callers then log and fall back to the legacy
 * inline send so the reset request still reaches the user.
 */
async function sendViaEmailBrain(_opts: {
  eventKey: string;
  toEmail: string;
  userId: string;
  name: string;
  secureVars: Record<string, string>;
  dedupeKey: string;
}): Promise<boolean> {
  // Email Brain is retired. Its queue wrote to a legacy `email_jobs` shape
  // (dedupe_key / event_key columns) that no longer exists, so it threw and
  // broke password reset. Always fall through to the caller's inline send,
  // which delivers via the working features/email pipeline.
  return false;
}

/** Legacy inline send (existing delivery layer + suppression rules). */
async function sendInline(
  to: string,
  templateName: string,
  variables: Record<string, string>,
  logTag: string,
): Promise<void> {
  const { sendTemplateEmail } = await import('@/features/email/email');
  sendTemplateEmail(to, templateName, variables)
    .then((result) => {
      if (!result.success) console.error(`[${logTag}] Email send failed: ${result.error}`);
    })
    .catch((err) => console.error(`[${logTag}] Email send threw:`, err?.message));
}

// Request password reset with OTP only — sends to primary email ONLY
export async function requestPasswordResetOtp(email: string): Promise<{ success: boolean; error?: string; code?: string }> {
  const user = await fetchLoginUserByEmail(email);
  if (!user) return { success: true };

  const code = (randomInt as Function)(100000, 1000000).toString();
  const otpHash = hashOtpCode(code);
  const expiresAt = addMinutes(new Date(), RESET_TTL_MINUTES);

  await prisma.otp.create({
    data: { userId: user.id, kind: RESET_OTP_KIND, address: email.toLowerCase(), otpHash, expiresAt },
  });

  const requestId = crypto.randomUUID();
  const sent = await sendViaEmailBrain({
    eventKey: 'auth.password_reset',
    toEmail: email,
    userId: user.id,
    name: user.name || 'there',
    secureVars: { otpCode: code, 'reset.code': code },
    dedupeKey: `otp:${user.id}:${requestId}`,
  });
  if (!sent) {
    console.warn('[PASSWORD RESET] secure store unavailable — falling back to inline send');
    sendInline(email, 'password_reset_otp', { OTP: code, otp: code, name: user.name || 'there' }, 'PASSWORD RESET OTP');
  }

  return { success: true, code };
}

// Request password reset with magic link ONLY — sends to primary email ONLY
export async function requestPasswordResetMagicLink(email: string): Promise<{ success: boolean; error?: string; resetUrl?: string }> {
  const user = await fetchLoginUserByEmail(email);
  if (!user) {
    return { success: true };
  }

  const resetToken = await signPasswordResetToken(user.id);
  const resetUrl = `${getAccountsBaseUrl()}/reset-password?token=${resetToken}`;
  const requestId = crypto.randomUUID();

  const sent = await sendViaEmailBrain({
    eventKey: 'auth.password_reset',
    toEmail: email,
    userId: user.id,
    name: user.name || 'there',
    secureVars: { resetUrl },
    dedupeKey: `link:${user.id}:${requestId}`,
  });
  if (!sent) {
    console.warn('[PASSWORD RESET] secure store unavailable — falling back to inline send');
    sendInline(email, 'password_reset_link', { resetUrl, name: user.name || 'there' }, 'PASSWORD RESET MAGIC LINK');
  }

  return { success: true, resetUrl };
}

// Request password reset — send the OTP to the user's recovery (secondary) email ONLY
export async function requestPasswordResetRecovery(email: string): Promise<{ success: boolean; error?: string; code?: string; retryAfterMs?: number }> {
  const user = await fetchLoginUserByEmail(email);
  if (!user) {
    // Don't reveal if user exists or has recovery email
    return { success: true };
  }
  // 'banned' is not a UserStatusKind — banning is tracked by users.is_banned, not
  // by status. Only compare statuses the enum can actually hold.
  if (user.status === 'suspended' || user.status === 'deleted') {
    return { success: true };
  }
  // The login address may itself be the recovery address somebody typed into
  // the forgot-password field — deliver to the recovery row, never to itself.
  const recoveryEmail = await verifiedRecoveryAddress(user.id);
  if (!recoveryEmail || recoveryEmail.toLowerCase() === (user.email || '').toLowerCase()) {
    // Nothing proven to deliver to. Say nothing, send nothing: a code posted to
    // an unverified mailbox is a reset handed to whoever reads that inbox.
    return { success: true };
  }

  const cooldown = await enforceResendCooldown(`password-reset-recovery:${recoveryEmail.toLowerCase()}`);
  if (!cooldown.allowed) {
    return { success: false, error: 'Please wait before requesting another code.', retryAfterMs: cooldown.remainingMs };
  }

  const code = (randomInt as Function)(100000, 1000000).toString();
  const otpHash = hashOtpCode(code);
  const expiresAt = addMinutes(new Date(), RESET_TTL_MINUTES);

  // Recorded against the mailbox it was actually posted to; verification looks
  // the code up by account, so the person can confirm with either address.
  await prisma.otp.create({
    data: { userId: user.id, kind: RESET_OTP_KIND, address: recoveryEmail.toLowerCase(), otpHash, expiresAt },
  });

  const requestId = crypto.randomUUID();
  const sent = await sendViaEmailBrain({
    eventKey: 'auth.password_reset',
    toEmail: recoveryEmail,
    userId: user.id,
    name: user.name || 'there',
    secureVars: { otpCode: code, 'reset.code': code },
    dedupeKey: `recovery:${user.id}:${requestId}`,
  });
  if (!sent) {
    console.warn('[PASSWORD RESET RECOVERY] secure store unavailable — falling back to inline send');
    sendInline(
      recoveryEmail,
      'password_reset_otp_recovery',
      {
        OTP: code, otp: code, name: user.name || 'there',
        primaryEmail: (user.email || email).toLowerCase(), targetEmail: recoveryEmail, recoveryEmail,
      },
      'PASSWORD RESET RECOVERY',
    );
  }

  return { success: true, code };
}

type ResetMethod = 'otp' | 'magic_link';

// Request password reset — generates OTP code OR magic link based on method
// Sends to PRIMARY email ONLY (not secondary/recovery)
export async function requestPasswordReset(
  email: string,
  method: ResetMethod = 'otp'
): Promise<{ success: boolean; error?: string; resetUrl?: string; code?: string; retryAfterMs?: number }> {
  try {
    return await __requestPasswordResetInner(email, method);
  } catch (e: any) {
    try { require('fs').appendFileSync('scripts/tmp/err.log', 'REQUEST RESET THREW: ' + (e?.stack || e?.message || String(e)) + '\n'); } catch {}
    throw e;
  }
}
async function __requestPasswordResetInner(
  email: string,
  method: ResetMethod = 'otp'
): Promise<{ success: boolean; error?: string; resetUrl?: string; code?: string; retryAfterMs?: number }> {
  const cooldown = await enforceResendCooldown(`password-reset:${email.toLowerCase()}`);
  if (!cooldown.allowed) {
    return { success: false, error: 'Please wait before requesting another code.', retryAfterMs: cooldown.remainingMs };
  }

  const user = await fetchLoginUserByEmail(email);
  if (!user) {
    // Don't reveal if user exists
    return { success: true };
  }

  if (method === 'magic_link') {
    const resetToken = await signPasswordResetToken(user.id);
    const resetUrl = `${getAccountsBaseUrl()}/reset-password?token=${resetToken}`;
    const requestId = crypto.randomUUID();

    const sent = await sendViaEmailBrain({
      eventKey: 'auth.password_reset',
      toEmail: email,
      userId: user.id,
      name: user.name || 'there',
      secureVars: { resetUrl },
      dedupeKey: `link:${user.id}:${requestId}`,
    });
    if (!sent) {
      console.warn('[PASSWORD RESET] secure store unavailable — falling back to inline send');
      sendInline(email, 'password_reset_link', { resetUrl, name: user.name || 'there' }, 'PASSWORD RESET');
    }

    return { success: true, resetUrl };
  } else {
    // OTP method (default)
    const code = (randomInt as Function)(100000, 1000000).toString();
    const otpHash = hashOtpCode(code);
    const expiresAt = addMinutes(new Date(), RESET_TTL_MINUTES);

    await prisma.otp.create({
      data: { userId: user.id, kind: RESET_OTP_KIND, address: email.toLowerCase(), otpHash, expiresAt },
    });

    const requestId = crypto.randomUUID();
    const sent = await sendViaEmailBrain({
      eventKey: 'auth.password_reset',
      toEmail: email,
      userId: user.id,
      name: user.name || 'there',
      secureVars: { otpCode: code, 'reset.code': code },
      dedupeKey: `otp:${user.id}:${requestId}`,
    });
    if (!sent) {
      console.warn('[PASSWORD RESET] secure store unavailable — falling back to inline send');
      sendInline(email, 'password_reset_otp', { OTP: code, otp: code, name: user.name || 'there' }, 'PASSWORD RESET OTP');
    }

    return { success: true, code };
  }
}

// Verify code OR token — returns a new session-ready reset token
export async function verifyPasswordReset(
  email: string,
  params: { code?: string; token?: string }
): Promise<{ success: boolean; error?: string; resetToken?: string }> {
  const user = await fetchLoginUserByEmail(email);
  if (!user) return { success: false, error: 'Invalid or expired reset request' };

  let verified = false;

  // Try code verification
  if (params.code) {
    const otp = await findLiveResetOtp(user.id);
    if (otp) {
      const ok = await verifyOtpCode(otp.otpHash, params.code);
      if (ok) {
        verified = true;
        // Delete ALL OTPs for this user (expires the other method)
        await prisma.otp.deleteMany({ where: { userId: user.id, kind: RESET_OTP_KIND } });
      } else {
        await registerResetFailedAttempt(otp.id, otp.attempts ?? 0);
      }
    }
  }

  // Try token verification
  if (params.token) {
    const tokenUserId = await verifyPasswordResetToken(params.token);
    if (tokenUserId === user.id) {
      verified = true;
      // Delete ALL OTPs for this user (expires the other method)
      await prisma.otp.deleteMany({ where: { userId: user.id, kind: RESET_OTP_KIND } });
    }
  }

  if (!verified) return { success: false, error: 'Invalid or expired reset code/link' };

  // Generate a short-lived token for the password set step
  const { signPasswordResetToken: sign } = await import('@/features/auth/jwt');
  const confirmToken = await sign(user.id);
  return { success: true, resetToken: confirmToken };
}

// Password strength check
function checkPasswordStrength(pw: string): { ok: boolean; error?: string } {
  if (pw.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  if (pw.length > 128) return { ok: false, error: 'Password must be at most 128 characters.' };
  if (!/[a-z]/.test(pw)) return { ok: false, error: 'Password must contain at least one lowercase letter.' };
  if (!/[A-Z]/.test(pw)) return { ok: false, error: 'Password must contain at least one uppercase letter.' };
  if (!/[0-9]/.test(pw)) return { ok: false, error: 'Password must contain at least one number.' };
  // Check for common weak passwords
  const weak = ['password', 'password1', 'qwerty', '12345678', 'abc12345', 'letmein', 'admin', 'welcome', 'monkey', 'dragon'];
  if (weak.includes(pw.toLowerCase())) return { ok: false, error: 'This password is too common. Please choose a stronger one.' };
  return { ok: true };
}

// Actually set the new password — doesn't need email, token encodes userId
export async function confirmPasswordReset(
  resetToken: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const strength = checkPasswordStrength(newPassword);
  if (!strength.ok) return { success: false, error: strength.error };

  // Check HIBP breach database
  try {
    const { checkPasswordBreach } = await import('@/features/auth/breach');
    const breach = await checkPasswordBreach(newPassword);
    if (breach.breached) {
      return { success: false, error: `This password has appeared in ${breach.count.toLocaleString()} data breaches. Please choose a different one.` };
    }
  } catch {
    // Non-blocking: if HIBP check fails, allow the reset
  }

  const userId = await verifyPasswordResetToken(resetToken);
  if (!userId) return { success: false, error: 'Invalid or expired reset token' };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { success: false, error: 'User not found' };

  // Don't allow the same password
  if (user.passwordHash) {
    const { verifyPassword } = await import('@/features/auth/password');
    const same = await verifyPassword(user.passwordHash, newPassword);
    if (same) return { success: false, error: 'New password must be different from your current password.' };
  }

  const { hashPassword } = await import('@/features/auth/password');
  const hash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: hash },
  });
  await prisma.userSecurity.upsert({
    where: { userId: user.id },
    create: { userId: user.id, mustChangePw: false },
    update: { mustChangePw: false },
  });

  // Clean up any remaining OTPs
  await prisma.otp.deleteMany({ where: { userId: user.id, kind: RESET_OTP_KIND } });

  // Invalidate all sessions (they need to re-authenticate with new password)
  await prisma.userSession.deleteMany({ where: { userId: user.id } });

  // Notify user that their password was changed (skipEmail — Email Brain sends dedicated template)
  try {
    const { createNotification } = await import('@/features/notifications/notifications');
    createNotification({
      userId: user.id,
      type: 'security',
      title: 'Password changed',
      body: 'Your password has been successfully changed. All other sessions have been signed out.',
      link: '/account/security',
      skipEmail: true,
    }).catch(() => {});
  } catch {
    // Non-blocking
  }

  // Notify the user their password changed (non-blocking, inline send).
  const loginUser = await fetchLoginUserById(user.id).catch(() => null);
  if (loginUser?.email) {
    sendInline(
      loginUser.email,
      'password_changed',
      { name: loginUser.name || 'there', changedAt: new Date().toISOString(), ipAddress: '' },
      'PASSWORD CHANGED',
    );
  }

  return { success: true };
}

// Quick login via OTP — verify code and create session directly (no password change)
export async function quickLoginWithOtp(
  email: string,
  code: string
): Promise<{ success: boolean; error?: string; sessionToken?: string; refreshToken?: string; userId?: string }> {
  const user = await fetchLoginUserByEmail(email);
  if (!user) return { success: false, error: 'Invalid or expired code' };
  if (user.status === 'deleted') return { success: false, error: 'This account has been deleted.' };
  if (user.status === 'suspended') {
    return {
      success: false,
      error: 'ACCOUNT_SUSPENDED',
      suspended: true,
      block: {
        kind: 'suspended',
        eventId: eventIdFor(user.id, 'suspend'),
        reason: null,
        until: null,
        message: 'Your account is temporarily suspended.',
      },
    } as any;
  }
  const emailRow = await prisma.userEmail.findFirst({
    where: { userId: user.id, address: email.toLowerCase() },
    select: { verifiedAt: true },
  });
  if (!emailRow?.verifiedAt) return { success: false, error: 'Please verify your email before signing in' };

  // Find the latest OTP for this user (attempt-capped, mirror signup-otp).
  const otp = await findLiveResetOtp(user.id);
  if (!otp) {
    return { success: false, error: 'Invalid or expired code' };
  }

  const ok = await verifyOtpCode(otp.otpHash, code);
  if (!ok) {
    await registerResetFailedAttempt(otp.id, otp.attempts ?? 0);
    return { success: false, error: 'Invalid or expired code' };
  }

  // Delete all OTPs for this user
  await prisma.otp.deleteMany({ where: { userId: user.id, kind: RESET_OTP_KIND } });

  // Create a session (short-term session, same as login OTP / magic link)
  const { createSession } = await import('@/features/auth/session');
  const session = await createSession(user.id, undefined, undefined, undefined, true);

  return { success: true, sessionToken: session.token, refreshToken: session.refreshToken, userId: user.id };
}
