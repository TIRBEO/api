import { prisma } from '../db/prisma';
import { hashOtpCode, verifyOtpCode as verifyOtpHash } from './password';
import { addMinutes } from 'date-fns';
import { randomInt } from 'crypto';

const OTP_TTL_MINUTES = 10;

/** Generate a 6‑digit numeric OTP */
export function generateOtpCode(): string {
  return randomInt(100000, 1000000).toString();
}

/** Store OTP hash for a user */
export async function storeOtp(userId: string, type: 'email' | 'phone' | 'email_verify', code: string) {
  const otpHash = hashOtpCode(code);
  const expiresAt = addMinutes(new Date(), OTP_TTL_MINUTES);
  await prisma.otp.create({
    data: {
      userId,
      type,
      otpHash,
      expiresAt,
    },
  });
}

/** Verify OTP and delete it */
export async function verifyOtpCode(userId: string, type: 'email' | 'phone' | 'email_verify', code: string): Promise<boolean> {
  const otp = await prisma.otp.findFirst({
    where: { userId, type },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) {
    return false;
  }
  if (otp.expiresAt < new Date()) {
    await prisma.otp.delete({ where: { id: otp.id } });
    return false;
  }
  const ok = await verifyOtpHash(otp.otpHash, code);
  if (ok) {
    await prisma.otp.delete({ where: { id: otp.id } });
  }
  return ok;
}

/** Send OTP via configured email provider (Resend or SMTP) */
export async function sendEmailOtp(email: string, code: string) {
  const { sendTemplateEmail } = await import('../email');
  const result = await sendTemplateEmail(email, 'verify_email', { otp: code });
  if (!result.success) {
    console.error(`[EMAIL OTP] Failed to send to ${email}: ${result.error}`);
  }
}

/** Placeholder SMS sender – replace with a free Nepali SMS provider */
export async function sendPhoneOtp(phone: string, code: string) {
  // Integrate with an SMS gateway like Textbelt, MSG91, or Twilio trial.
  console.log(`[SMS OTP] To: ${phone}, Code: ${code}`);
}
