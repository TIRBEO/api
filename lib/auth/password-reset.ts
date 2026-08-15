import { prisma } from '../db/prisma';
import { hashOtpCode, verifyOtpCode } from './password';
import { signPasswordResetToken, verifyPasswordResetToken } from './jwt';
import { addMinutes } from 'date-fns';
import { sendTemplateEmail } from '../email';
import { randomInt } from 'crypto';
import { enforceResendCooldown } from './resend-cooldown';
import { getAccountsBaseUrl } from '../app-urls';

const RESET_TTL_MINUTES = 15;

// Request password reset with OTP only
export async function requestPasswordResetOtp(email: string): Promise<{ success: boolean; error?: string; code?: string }> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return { success: true };

  const code = (randomInt as Function)(100000, 1000000).toString();
  const otpHash = hashOtpCode(code);
  const expiresAt = addMinutes(new Date(), RESET_TTL_MINUTES);

  await prisma.otp.create({
    data: { userId: user.id, type: 'email', otpHash, expiresAt },
  });

  sendTemplateEmail(email, 'password_reset_otp', {
    OTP: code,
    otp: code,
    name: user.name || 'there',
  })
    .then((result) => {
      if (!result.success) {
        console.error(`[PASSWORD RESET OTP] Email send failed for ${email}: ${result.error}`);
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[PASSWORD RESET OTP] FALLBACK CODE for ${email}: ${code}`);
        }
      }
    })
    .catch((err) => console.error('[PASSWORD RESET OTP] Email send threw:', err?.message));

  if (user.secondaryEmail) {
    sendTemplateEmail(user.secondaryEmail, 'password_reset_otp', {
      OTP: code,
      otp: code,
      name: user.name || 'there',
    }).catch(err => console.error('[PASSWORD RESET OTP] Secondary email failed:', err?.message));
  }

  return { success: true, code };
}

// Request password reset with magic link ONLY
export async function requestPasswordResetMagicLink(email: string): Promise<{ success: boolean; error?: string; resetUrl?: string }> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    return { success: true };
  }

  const resetToken = await signPasswordResetToken(user.id);
  const resetUrl = `${getAccountsBaseUrl()}/reset-password?token=${resetToken}`;

  sendTemplateEmail(email, 'password_reset_link', {
    resetUrl,
    name: user.name || 'there',
  })
    .then((result) => {
      if (!result.success) {
        console.error(`[PASSWORD RESET MAGIC LINK] Email send failed for ${email}: ${result.error}`);
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[PASSWORD RESET] FALLBACK URL for ${email}: ${resetUrl}`);
        }
      }
    })
    .catch((err) => console.error('[PASSWORD RESET MAGIC LINK] Email send threw:', err?.message));

  if (user.secondaryEmail) {
    sendTemplateEmail(user.secondaryEmail, 'password_reset_link', {
      resetUrl,
      name: user.name || 'there',
    }).catch(err => console.error('[PASSWORD RESET MAGIC LINK] Secondary email failed:', err?.message));
  }

  return { success: true, resetUrl };
}

// Request password reset — send the OTP to the user's recovery (secondary) email only
export async function requestPasswordResetRecovery(email: string): Promise<{ success: boolean; error?: string; code?: string; retryAfterMs?: number }> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !user.secondaryEmail) {
    return { success: false, error: 'No recovery email on file for this account' };
  }

  const cooldown = enforceResendCooldown(`password-reset-recovery:${user.secondaryEmail.toLowerCase()}`);
  if (!cooldown.allowed) {
    return { success: false, error: 'Please wait before requesting another code.', retryAfterMs: cooldown.remainingMs };
  }

  const code = (randomInt as Function)(100000, 1000000).toString();
  const otpHash = hashOtpCode(code);
  const expiresAt = addMinutes(new Date(), RESET_TTL_MINUTES);

  await prisma.otp.create({
    data: { userId: user.id, type: 'email', otpHash, expiresAt },
  });

  const result = sendTemplateEmail(user.secondaryEmail, 'password_reset_otp', {
    OTP: code,
    otp: code,
    name: user.name || 'there',
  });
  result
    .then((r) => {
      if (!r.success) {
        console.error(`[PASSWORD RESET RECOVERY] Email send failed for ${user.secondaryEmail}: ${r.error}`);
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[PASSWORD RESET RECOVERY] FALLBACK CODE for ${user.secondaryEmail}: ${code}`);
        }
      }
    })
    .catch((err) => console.error('[PASSWORD RESET RECOVERY] Email send threw:', err?.message));

  return { success: true, code };
}

type ResetMethod = 'otp' | 'magic_link';

// Request password reset — generates OTP code OR magic link based on method
export async function requestPasswordReset(
  email: string,
  method: ResetMethod = 'otp'
): Promise<{ success: boolean; error?: string; resetUrl?: string; code?: string; retryAfterMs?: number }> {
  const cooldown = enforceResendCooldown(`password-reset:${email.toLowerCase()}`);
  if (!cooldown.allowed) {
    return { success: false, error: 'Please wait before requesting another code.', retryAfterMs: cooldown.remainingMs };
  }

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    // Don't reveal if user exists
    return { success: true };
  }

  if (method === 'magic_link') {
    // Generate JWT reset token for the link
    const resetToken = await signPasswordResetToken(user.id);
    const resetUrl = `${getAccountsBaseUrl()}/reset-password?token=${resetToken}`;

    // Send email with magic link only (non-blocking — response must be fast)
    sendTemplateEmail(email, 'password_reset_link', {
      resetUrl,
      name: user.name || 'there',
    })
      .then((result) => {
        if (!result.success) {
          console.error(`[PASSWORD RESET] Email send failed for ${email}: ${result.error}`);
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[PASSWORD RESET] FALLBACK URL for ${email}: ${resetUrl}`);
          }
        }
      })
      .catch((err) => console.error('[PASSWORD RESET] Email send threw:', err?.message));

    if (user.secondaryEmail) {
      sendTemplateEmail(user.secondaryEmail, 'password_reset_link', {
        resetUrl,
        name: user.name || 'there',
      }).catch(err => console.error('[PASSWORD RESET] Secondary email failed:', err?.message));
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

    // Send email with OTP only (non-blocking — response must be fast)
    sendTemplateEmail(email, 'password_reset_otp', {
      OTP: code,
      otp: code,
      name: user.name || 'there',
    })
      .then((result) => {
        if (!result.success) {
          console.error(`[PASSWORD RESET OTP] Email send failed for ${email}: ${result.error}`);
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[PASSWORD RESET OTP] FALLBACK CODE for ${email}: ${code}`);
          }
        }
      })
      .catch((err) => console.error('[PASSWORD RESET OTP] Email send threw:', err?.message));

    if (user.secondaryEmail) {
      sendTemplateEmail(user.secondaryEmail, 'password_reset_otp', {
        OTP: code,
        otp: code,
        name: user.name || 'there',
      }).catch(err => console.error('[PASSWORD RESET OTP] Secondary email failed:', err?.message));
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
  const { signPasswordResetToken: sign } = await import('./jwt');
  const confirmToken = await sign(user.id);
  return { success: true, resetToken: confirmToken };
}

// Actually set the new password — doesn't need email, token encodes userId
export async function confirmPasswordReset(
  resetToken: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const userId = await verifyPasswordResetToken(resetToken);
  if (!userId) return { success: false, error: 'Invalid or expired reset token' };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { success: false, error: 'User not found' };

  const { hashPassword } = await import('./password');
  const hash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: hash, mustChangePassword: false },
  });

  // Clean up any remaining OTPs
  await prisma.otp.deleteMany({ where: { userId: user.id, type: 'email' } });

  // Invalidate all sessions for this user (they need to re-authenticate with new password)
  await prisma.session.deleteMany({ where: { userId: user.id } });

  return { success: true };
}
