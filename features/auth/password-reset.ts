import { prisma } from '@/infrastructure/db/prisma';
import { hashOtpCode, verifyOtpCode } from '@/features/auth/password';
import { signPasswordResetToken, verifyPasswordResetToken } from '@/features/auth/jwt';
import { addMinutes } from 'date-fns';
import { randomInt } from 'crypto';
import { enforceResendCooldown } from '@/features/auth/resend-cooldown';
import { getAccountsBaseUrl } from '@/config/app-urls';
import { emitEmailEvent } from '@/features/email-brain/decide';
import { putSecureVars } from '@/features/email-brain/secureVars';

const RESET_TTL_MINUTES = 15;
const SECURE_TTL_S = RESET_TTL_MINUTES * 60;

/**
 * Shared send helper — routes through the Email Brain decision engine.
 * Security-critical values (OTP code, reset URL) go into the Redis secure
 * store, never into the DB job payload. Returns false when the value could
 * not be secured (Redis down) — callers then log and fall back to the legacy
 * inline send so the reset request still reaches the user.
 */
async function sendViaEmailBrain(opts: {
  eventKey: string;
  toEmail: string;
  userId: string;
  name: string;
  secureVars: Record<string, string>;
  dedupeKey: string;
}): Promise<boolean> {
  const secure = await putSecureVars(opts.secureVars, SECURE_TTL_S);
  if (!secure) return false; // fail closed — caller decides fallback

  const outcome = await emitEmailEvent({
    eventKey: opts.eventKey,
    userId: opts.userId,
    toEmail: opts.toEmail,
    dedupeKey: opts.dedupeKey,
    // Only NON-sensitive values in the payload: display name + the one-time
    // reference id the worker's resolver consumes for the actual secret.
    vars: { 'user.name': opts.name, secureRef: secure.ref },
  });
  // Note: outcome 'duplicate' is fine — a job for this request already exists.
  return outcome.outcome === 'queued' || outcome.outcome === 'duplicate';
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
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return { success: true };

  const code = (randomInt as Function)(100000, 1000000).toString();
  const otpHash = hashOtpCode(code);
  const expiresAt = addMinutes(new Date(), RESET_TTL_MINUTES);

  await prisma.otp.create({
    data: { userId: user.id, type: 'email', otpHash, expiresAt },
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
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
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
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !user.secondaryEmail) {
    return { success: false, error: 'No recovery email on file for this account' };
  }

  const cooldown = await enforceResendCooldown(`password-reset-recovery:${user.secondaryEmail.toLowerCase()}`);
  if (!cooldown.allowed) {
    return { success: false, error: 'Please wait before requesting another code.', retryAfterMs: cooldown.remainingMs };
  }

  const code = (randomInt as Function)(100000, 1000000).toString();
  const otpHash = hashOtpCode(code);
  const expiresAt = addMinutes(new Date(), RESET_TTL_MINUTES);

  await prisma.otp.create({
    data: { userId: user.id, type: 'email', otpHash, expiresAt },
  });

  const requestId = crypto.randomUUID();
  const sent = await sendViaEmailBrain({
    eventKey: 'auth.password_reset',
    toEmail: user.secondaryEmail,
    userId: user.id,
    name: user.name || 'there',
    secureVars: { otpCode: code, 'reset.code': code },
    dedupeKey: `recovery:${user.id}:${requestId}`,
  });
  if (!sent) {
    console.warn('[PASSWORD RESET RECOVERY] secure store unavailable — falling back to inline send');
    sendInline(
      user.secondaryEmail,
      'password_reset_otp_recovery',
      {
        OTP: code, otp: code, name: user.name || 'there',
        primaryEmail: email.toLowerCase(), targetEmail: email.toLowerCase(), recoveryEmail: user.secondaryEmail,
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

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
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
      data: { userId: user.id, type: 'email', otpHash, expiresAt },
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
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return { success: false, error: 'Invalid or expired reset request' };

  let verified = false;

  // Try code verification
  if (params.code) {
    const otp = await prisma.otp.findFirst({
      where: { userId: user.id, type: 'email' },
      orderBy: { createdAt: 'desc' },
    });
    if (otp && otp.expiresAt >= new Date()) {
      const ok = await verifyOtpCode(otp.otpHash, params.code);
      if (ok) {
        verified = true;
        // Delete ALL OTPs for this user (expires the other method)
        await prisma.otp.deleteMany({ where: { userId: user.id, type: 'email' } });
      }
    }
  }

  // Try token verification
  if (params.token) {
    const tokenUserId = await verifyPasswordResetToken(params.token);
    if (tokenUserId === user.id) {
      verified = true;
      // Delete ALL OTPs for this user (expires the other method)
      await prisma.otp.deleteMany({ where: { userId: user.id, type: 'email' } });
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
    data: { passwordHash: hash, mustChangePassword: false },
  });

  // Clean up any remaining OTPs
  await prisma.otp.deleteMany({ where: { userId: user.id, type: 'email' } });

  // Invalidate all sessions (they need to re-authenticate with new password)
  await prisma.session.deleteMany({ where: { userId: user.id } });

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

  // Notify via email through the Email Brain (non-blocking, never suppressed).
  emitEmailEvent({
    eventKey: 'auth.password_changed',
    userId: user.id,
    toEmail: user.email,
    dedupeKey: `password-changed:${user.id}:${Date.now()}`,
    vars: { 'user.name': user.name || 'there', changedAt: new Date().toISOString() },
  }).catch(() => {});

  return { success: true };
}

// Quick login via OTP — verify code and create session directly (no password change)
export async function quickLoginWithOtp(
  email: string,
  code: string
): Promise<{ success: boolean; error?: string; sessionToken?: string; refreshToken?: string; userId?: string }> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return { success: false, error: 'Invalid or expired code' };
  if (user.deletedAt) return { success: false, error: 'This account has been deleted.' };
  if (user.isBanned) {
    return {
      success: false,
      error: 'ACCOUNT_BANNED',
      banned: true,
      block: { kind: 'banned', eventId: (user as any).banRefCode || null, message: 'Your account has been permanently banned.' },
    } as any;
  }
  if (user.isSuspended) {
    return {
      success: false,
      error: 'ACCOUNT_SUSPENDED',
      suspended: true,
      block: {
        kind: 'suspended',
        eventId: (user as any).suspendRefCode || null,
        reason: (user as any).suspendReason || null,
        until: (user as any).suspendedUntil || null,
        message: 'Your account is temporarily suspended.',
      },
    } as any;
  }
  if (!user.emailVerified) return { success: false, error: 'Please verify your email before signing in' };

  // Find the latest OTP for this user
  const otp = await prisma.otp.findFirst({
    where: { userId: user.id, type: 'email' },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp || otp.expiresAt < new Date()) {
    return { success: false, error: 'Invalid or expired code' };
  }

  const ok = await verifyOtpCode(otp.otpHash, code);
  if (!ok) {
    return { success: false, error: 'Invalid or expired code' };
  }

  // Delete all OTPs for this user
  await prisma.otp.deleteMany({ where: { userId: user.id, type: 'email' } });

  // Create a session (short-term session, same as login OTP / magic link)
  const { createSession } = await import('@/features/auth/session');
  const session = await createSession(user.id, undefined, undefined, undefined, true);

  return { success: true, sessionToken: session.token, refreshToken: session.refreshToken, userId: user.id };
}
