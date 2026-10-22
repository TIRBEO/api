 
import * as otplib from 'otplib';

const { generateSecret: otpGenerateSecret, generateURI, verify } = otplib as any;

export function generateSecret(): string {
  return otpGenerateSecret();
}

export function generateTotpUri(secret: string, email: string): string {
  return generateURI({ secret, label: email, issuer: 'Tirbeo', type: 'totp' });
}

export async function verifyTotp(token: string, secret: string): Promise<boolean> {
  // epochTolerance: 30 -> accept codes from +/- one 30s step. Authenticator
  // apps commonly run on devices with a few seconds of clock skew, and users
  // often scan/enter codes right at the window boundary; requiring the exact
  // current step alone causes intermittent 400 "Invalid code" failures.
  const result = await verify({ secret, token, epochTolerance: 30 });
  return result.valid === true;
}

export function normalizeTotpCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\s+/g, '').trim();
  if (!/^\d{6}$/.test(digits)) return null;
  return digits;
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // 8 bytes = 64 bits per code (was 40). A single-use code guarded by
    // attempt limits still should not be guessable from a phone in a minute.
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    const hex = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
    codes.push(hex.match(/.{1,4}/g)!.join('-'));
  }
  return codes;
}
