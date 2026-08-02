import { prisma } from '../db/prisma';
import { hashPassword as hashOtp, verifyPassword as verifyOtp } from './password';
import { signPasswordResetToken, verifyPasswordResetToken } from './jwt';
import { addMinutes } from 'date-fns';
import { sendTemplateEmail } from '../email';
import { randomInt } from 'crypto';
import { enforceResendCooldown } from './resend-cooldown';

const RESET_TTL_MINUTES = 15;

// Request password reset with OTP only
export async function requestPasswordResetOtp(email: string): Promise<{ success: boolean; error?: string; code?: string }> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return { success: true };

  const code = randomInt(100000, 1000000).toString();
  const otpHash = await hashOtp(code);
  const expiresAt = addMinutes(new Date(), RESET_TTL_MINUTES);

  await prisma.otp.create({
    data: { userId: user.id, type: 'email', otpHash, expiresAt },
  });

  const result = await sendTemplateEmail(email, 'password_reset_otp', {
    OTP: code,
    otp: code,
    name: user.name || 'there',
  });

  if (user.secondaryEmail) {
    sendTemplateEmail(user.secondaryEmail, 'password_reset_otp', {
      OTP: code,
      otp: code,
      name: user.name || 'there',
    }).catch(err => console.error('[PASSWORD RESET OTP] Secondary email failed:', err?.message));
  }

  if (!result.success) {
    console.error(`[PASSWORD RESET OTP] Email send failed for ${email}: ${result.error}`);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[PASSWORD RESET OTP] FALLBACK CODE for ${email}: ${code}`);
    }
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
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
  const resetUrl = `https://accounts.${appDomain}/reset-password?token=${resetToken}`;

  const result = await sendTemplateEmail(email, 'password_reset_link', {
    resetUrl,
    name: user.name || 'there',
  });

  if (user.secondaryEmail) {
    sendTemplateEmail(user.secondaryEmail, 'password_reset_link', {
      resetUrl,
      name: user.name || 'there',
    }).catch(err => console.error('[PASSWORD RESET MAGIC LINK] Secondary email failed:', err?.message));
  }

  if (!result.success) {
    console.error(`[PASSWORD RESET MAGIC LINK] Email send failed for ${email}: ${result.error}`);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[PASSWORD RESET] FALLBACK URL for ${email}: ${resetUrl}`);
    }
  }

  return { success: true, resetUrl };
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

  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';

  if (method === 'magic_link') {
    // Generate JWT reset token for the link
    const resetToken = await signPasswordResetToken(user.id);
    const resetUrl = `https://accounts.${appDomain}/reset-password?token=${resetToken}`;

    // Send email with magic link only
    const result = await sendTemplateEmail(email, 'password_reset_link', {
      resetUrl,
      name: user.name || 'there',
    });

    if (user.secondaryEmail) {
      sendTemplateEmail(user.secondaryEmail, 'password_reset_link', {
        resetUrl,
        name: user.name || 'there',
      }).catch(err => console.error('[PASSWORD RESET] Secondary email failed:', err?.message));
    }

    if (!result.success) {
      console.error(`[PASSWORD RESET] Email send failed for ${email}: ${result.error}`);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[PASSWORD RESET] FALLBACK URL for ${email}: ${resetUrl}`);
      }
    }

    return { success: true, resetUrl };
  } else {
    // OTP method (default)
    const code = randomInt(100000, 1000000).toString();
    const otpHash = await hashOtp(code);
    const expiresAt = addMinutes(new Date(), RESET_TTL_MINUTES);

    await prisma.otp.create({
      data: { userId: user.id, type: 'email', otpHash, expiresAt },
    });

    // Send email with OTP only
    const result = await sendTemplateEmail(email, 'password_reset_otp', {
      OTP: code,
      otp: code,
      name: user.name || 'there',
    });

    if (user.secondaryEmail) {
      sendTemplateEmail(user.secondaryEmail, 'password_reset_otp', {
        OTP: code,
        otp: code,
        name: user.name || 'there',
      }).catch(err => console.error('[PASSWORD RESET OTP] Secondary email failed:', err?.message));
    }

    if (!result.success) {
      console.error(`[PASSWORD RESET OTP] Email send failed for ${email}: ${result.error}`);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[PASSWORD RESET OTP] FALLBACK CODE for ${email}: ${code}`);
      }
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
      const ok = await verifyOtp(otp.otpHash, params.code);
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
    data: { passwordHash: hash },
  });

  // Clean up any remaining OTPs
  await prisma.otp.deleteMany({ where: { userId: user.id, type: 'email' } });

  // Invalidate all sessions for this user (they need to re-authenticate with new password)
  await prisma.session.deleteMany({ where: { userId: user.id } });

  return { success: true };
}
