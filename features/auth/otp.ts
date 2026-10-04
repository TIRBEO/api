import { prisma } from '@/infrastructure/db/prisma';
import { hashOtpCode, verifyOtpCode as verifyOtpHash } from '@/features/auth/password';
import { addMinutes } from 'date-fns';
import { randomInt } from 'crypto';

const OTP_TTL_MINUTES = 15;

const bindTo = (code: string, bind?: string | null) => (bind ? `${code} ${bind.trim().toLowerCase()}` : code);

/** Generate a 6‑digit numeric OTP */
export function generateOtpCode(): string {
  return (randomInt as Function)(100000, 1000000).toString();
}

/** Store OTP hash for a user
    `bind` ties the code to a piece of context — an address, say — so spending it
    later has to present the same context. Without it a code sent to one
    destination could be used to prove control of another. */
export async function storeOtp(userId: string, type: 'email' | 'email_verify', code: string, bind?: string | null) {
  const otpHash = hashOtpCode(bindTo(code, bind));
  const expiresAt = addMinutes(new Date(), OTP_TTL_MINUTES);
  await prisma.otp.create({
    data: {
      userId,
      kind: type,
      otpHash,
      expiresAt,
    },
  });
}

/** Verify OTP and delete it */
export async function verifyOtpCode(userId: string, type: 'email' | 'email_verify', code: string, bind?: string | null): Promise<boolean> {
  const otp = await prisma.otp.findFirst({
    where: { userId, kind: type },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) {
    return false;
  }
  if (otp.expiresAt < new Date()) {
    await prisma.otp.delete({ where: { id: otp.id } });
    return false;
  }
  const ok = await verifyOtpHash(otp.otpHash, bindTo(code, bind));
  if (ok) {
    await prisma.otp.delete({ where: { id: otp.id } });
  }
  return ok;
}

/** Send OTP via configured email provider (Resend) */
export async function sendEmailOtp(email: string, code: string) {
  const { sendTemplateEmail } = await import('@/features/email/email');
  const result = await sendTemplateEmail(email, 'verify_email', { otp: code });
  if (!result.success) {
    console.error(`[EMAIL OTP] Failed to send to ${email}: ${result.error}`);
  }
  // Always log in dev for testing
  if (process.env.NODE_ENV === 'development') {
    console.log(`[EMAIL OTP] CODE for ${email}: ${code}`);
  }
}
