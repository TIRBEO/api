import { prisma } from '../db/prisma';
import { hashOtpCode, verifyOtpCode } from './password';
import { addMinutes } from 'date-fns';
import { sendTemplateEmail } from '../email';
import { randomInt } from 'crypto';

const OTP_TTL_MINUTES = 10;

export function generateOtpCode(): string {
  return (randomInt as Function)(100000, 1000000).toString();
}

export async function storeSignupOtp(email: string, code: string) {
  const otpHash = hashOtpCode(code);
  const expiresAt = addMinutes(new Date(), OTP_TTL_MINUTES);
  // One live code per email — a fresh send replaces the previous one.
  await prisma.signupOtp.deleteMany({ where: { email: email.toLowerCase() } });
  await prisma.signupOtp.create({
    data: { email: email.toLowerCase(), otpHash, expiresAt },
  });
}

const MAX_OTP_ATTEMPTS = 5;

async function findLiveOtp(email: string) {
  const otp = await prisma.signupOtp.findFirst({
    where: { email: email.toLowerCase() },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) return null;
  if (otp.expiresAt < new Date()) {
    await prisma.signupOtp.delete({ where: { id: otp.id } }).catch(() => {});
    return null;
  }
  if ((otp.attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
    // Too many wrong tries — invalidate and force a new code.
    await prisma.signupOtp.delete({ where: { id: otp.id } }).catch(() => {});
    return null;
  }
  return otp;
}

/** Register a failed attempt; invalidates the code once MAX_OTP_ATTEMPTS is hit. */
async function registerFailedAttempt(otpId: string, attempts: number) {
  const next = attempts + 1;
  if (next >= MAX_OTP_ATTEMPTS) {
    await prisma.signupOtp.delete({ where: { id: otpId } }).catch(() => {});
  } else {
    await prisma.signupOtp.update({ where: { id: otpId }, data: { attempts: next } }).catch(() => {});
  }
}

export async function verifySignupOtp(email: string, code: string): Promise<boolean> {
  const otp = await findLiveOtp(email);
  if (!otp) return false;
  const ok = await verifyOtpCode(otp.otpHash, code);
  if (ok) {
    await prisma.signupOtp.delete({ where: { id: otp.id } }).catch(() => {});
  } else {
    await registerFailedAttempt(otp.id, otp.attempts ?? 0);
  }
  return ok;
}

/**
 * Check a signup OTP WITHOUT consuming it. Used by the pre-signup
 * verification step so the same code can still be presented at
 * `auth/signup` (which consumes it via verifySignupOtp).
 */
export async function checkSignupOtp(email: string, code: string): Promise<boolean> {
  const otp = await findLiveOtp(email);
  if (!otp) return false;
  const ok = await verifyOtpCode(otp.otpHash, code);
  if (!ok) {
    await registerFailedAttempt(otp.id, otp.attempts ?? 0);
  }
  return ok;
}

export async function sendSignupOtpEmail(email: string, code: string, templateName: string = 'signup_otp') {
  const result = await sendTemplateEmail(email, templateName, { otp: code });
  if (!result.success) {
    console.error(`[SIGNUP OTP] Email send failed for ${email}: ${result.error}`);
    // Note: OTP codes are NEVER logged for security.
  }
  return result;
}
