import { prisma } from '../db/prisma';
import { hashPassword as hashOtp, verifyPassword as verifyOtp } from './password';
import { signPasswordResetToken, verifyPasswordResetToken } from './jwt';
import { addMinutes } from 'date-fns';
import { sendTemplateEmail } from '../email';
import { randomInt } from 'crypto';

const RESET_TTL_MINUTES = 15;

// Request password reset — generates OTP code + JWT token, sends email with both
export async function requestPasswordReset(email: string): Promise<{ success: boolean; error?: string; resetUrl?: string }> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    // Don't reveal if user exists
    return { success: true };
  }

  // Generate OTP code
  const code = randomInt(100000, 1000000).toString();
  const otpHash = await hashOtp(code);
  const expiresAt = addMinutes(new Date(), RESET_TTL_MINUTES);

  await prisma.otp.create({
    data: { userId: user.id, type: 'email', otpHash, expiresAt },
  });

  // Generate JWT reset token for the link
  const resetToken = await signPasswordResetToken(user.id);
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app';
  const resetUrl = `https://accounts.${appDomain}/reset-password?token=${resetToken}`;

  // Send email with both code and link
  const result = await sendTemplateEmail(email, 'password_reset', {
    OTP: code,
    otp: code,
    resetUrl,
    name: user.name || 'there',
  });

  if (!result.success) {
    console.error(`[PASSWORD RESET] Email send failed for ${email}: ${result.error}`);
    console.log(`[PASSWORD RESET] FALLBACK CODE for ${email}: ${code}`);
    console.log(`[PASSWORD RESET] FALLBACK URL for ${email}: ${resetUrl}`);
  }

  return { success: true, resetUrl, code };
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

// Actually set the new password
export async function confirmPasswordReset(
  email: string,
  resetToken: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const tokenUserId = await verifyPasswordResetToken(resetToken);
  if (!tokenUserId) return { success: false, error: 'Invalid or expired reset token' };

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || user.id !== tokenUserId) return { success: false, error: 'Invalid reset token' };

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
