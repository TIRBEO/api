import * as argon2 from 'argon2';
import { createHmac } from 'crypto';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 2 ** 16, timeCost: 3, parallelism: 1 });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/-/g, '');
}

export function hashRecoveryCode(code: string): string {
  const pepper = process.env.RECOVERY_PEPPER;
  if (!pepper) {
    throw new Error('RECOVERY_PEPPER environment variable is required');
  }
  return createHmac('sha256', pepper).update(normalizeRecoveryCode(code)).digest('hex');
}

export function hashOtpCode(code: string): string {
  const pepper = process.env.OTP_PEPPER;
  if (!pepper) {
    throw new Error('OTP_PEPPER environment variable is required');
  }
  return createHmac('sha256', pepper).update(code).digest('hex');
}

export async function verifyOtpCode(hash: string, code: string): Promise<boolean> {
  const pepper = process.env.OTP_PEPPER;
  if (!pepper) {
    throw new Error('OTP_PEPPER environment variable is required');
  }
  const expected = createHmac('sha256', pepper).update(code).digest('hex');
  return expected === hash;
}
