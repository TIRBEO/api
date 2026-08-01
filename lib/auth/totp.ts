/* eslint-disable @typescript-eslint/no-explicit-any */
import * as otplib from 'otplib';

const { generateSecret: otpGenerateSecret, generateURI, verify } = otplib as any;

export function generateSecret(): string {
  return otpGenerateSecret();
}

export function generateTotpUri(secret: string, email: string): string {
  return generateURI({ secret, label: email, issuer: 'Tirbeo', type: 'totp' });
}

export async function verifyTotp(token: string, secret: string): Promise<boolean> {
  const result = await verify({ secret, token });
  return result.valid === true;
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const buf = new Uint8Array(5);
    crypto.getRandomValues(buf);
    const hex = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
    codes.push(hex.match(/.{1,4}/g)!.join('-'));
  }
  return codes;
}
