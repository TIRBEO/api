import { prisma } from '../db/prisma';
import { hashPassword as hashOtp, verifyPassword as verifyOtp } from './password';
import { addMinutes } from 'date-fns';
import { sendTemplateEmail } from '../email';
import { randomInt } from 'crypto';

const OTP_TTL_MINUTES = 10;

export function generateOtpCode(): string {
  return randomInt(100000, 1000000).toString();
}

export async function storeSignupOtp(email: string, code: string) {
  const otpHash = await hashOtp(code);
  const expiresAt = addMinutes(new Date(), OTP_TTL_MINUTES);
  await prisma.signupOtp.create({
    data: { email: email.toLowerCase(), otpHash, expiresAt },
  });
}

export async function verifySignupOtp(email: string, code: string): Promise<boolean> {
  const otp = await prisma.signupOtp.findFirst({
    where: { email: email.toLowerCase() },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) return false;
  if (otp.expiresAt < new Date()) {
    await prisma.signupOtp.delete({ where: { id: otp.id } });
    return false;
  }
  const ok = await verifyOtp(otp.otpHash, code);
  if (ok) {
    await prisma.signupOtp.delete({ where: { id: otp.id } });
  }
  return ok;
}

export async function sendSignupOtpEmail(email: string, code: string, templateName: string = 'signup_otp') {
  const result = await sendTemplateEmail(email, templateName, { otp: code });
  if (!result.success) {
    console.error(`[SIGNUP OTP] Email send failed for ${email}: ${result.error}`);
    console.log(`[SIGNUP OTP] FALLBACK CODE for ${email}: ${code}`);
  }
  return result;
}
