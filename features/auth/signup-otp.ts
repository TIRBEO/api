import { prisma } from '@/infrastructure/db/prisma';
import { hashOtpCode, verifyOtpCode } from '@/features/auth/password';
import { addMinutes } from 'date-fns';
import { sendTemplateEmail } from '@/features/email/email';
import { randomInt } from 'crypto';

const OTP_TTL_MINUTES = 15;
const OTP_TYPE_SIGNUP = 'signup';

export function generateOtpCode(): string {
  return (randomInt as Function)(100000, 1000000).toString();
}

/**
 * Signup OTPs live in the single `otps` table (type='signup', keyed by email
 * with a NULL user_id — the user row does not exist yet). One live code per
 * email — a fresh send replaces the previous one via the unique index.
 */
export async function storeSignupOtp(email: string, code: string) {
  const otpHash = hashOtpCode(code);
  const expiresAt = addMinutes(new Date(), OTP_TTL_MINUTES);
  const normalized = email.toLowerCase();
  await prisma.otp.deleteMany({ where: { kind: OTP_TYPE_SIGNUP, address: normalized } });
  await prisma.otp.create({
    data: { kind: OTP_TYPE_SIGNUP, address: normalized, otpHash, expiresAt },
  });
}

const MAX_OTP_ATTEMPTS = 5;

async function findLiveOtp(email: string) {
  const otp = await prisma.otp.findFirst({
    where: { kind: OTP_TYPE_SIGNUP, address: email.toLowerCase() },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) return null;
  if (otp.expiresAt < new Date()) {
    await prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
    return null;
  }
  if ((otp.attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
    // Too many wrong tries — invalidate and force a new code.
    await prisma.otp.delete({ where: { id: otp.id } }).catch(() => {});
    return null;
  }
  return otp;
}

/** Register a failed attempt; invalidates the code once MAX_OTP_ATTEMPTS is hit. */
async function registerFailedAttempt(otpId: string) {
  // Let the database do the counting: two concurrent wrong codes that both
  // read `attempts = 3` would otherwise write back `4` and buy a free attempt.
  await prisma.otp
    .update({ where: { id: otpId }, data: { attempts: { increment: 1 } } })
    .catch(() => {});
  await prisma.otp.deleteMany({ where: { id: otpId, attempts: { gte: MAX_OTP_ATTEMPTS } } }).catch(() => {});
}

export async function verifySignupOtp(email: string, code: string): Promise<boolean> {
  const otp = await findLiveOtp(email);
  if (!otp) return false;
  if (!(await verifyOtpCode(otp.otpHash, code))) {
    await registerFailedAttempt(otp.id);
    return false;
  }
  // Only a request that actually deleted the row has consumed the code, so a
  // replay of the same code cannot be accepted twice.
  const spent = await prisma.otp.deleteMany({ where: { id: otp.id } });
  return spent.count === 1;
}

/**
 * Check a signup OTP WITHOUT consuming it. Used by the pre-signup
 * verification step so the same code can still be presented at
 * `auth/signup` (which consumes it via verifySignupOtp).
 */
export async function checkSignupOtp(email: string, code: string): Promise<boolean> {
  const otp = await findLiveOtp(email);
  if (!otp) return false;
  if (await verifyOtpCode(otp.otpHash, code)) return true;
  await registerFailedAttempt(otp.id);
  return false;
}

export async function sendSignupOtpEmail(email: string, code: string, templateName: string = 'signup_otp') {
  const result = await sendTemplateEmail(email, templateName, { otp: code });
  if (!result.success) {
    console.error(`[SIGNUP OTP] Email send failed for ${email}: ${result.error}`);
    // Note: OTP codes are NEVER logged for security.
  }
  return result;
}
