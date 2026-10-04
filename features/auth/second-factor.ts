import { NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { verifyTotp, normalizeTotpCode } from '@/features/auth/totp';
import { hashRecoveryCode } from '@/features/auth/password';

/**
 * The require2FA account flag: only meaningful while a TOTP authenticator is
 * actually enrolled (the DB is the guard, not the UI toggle). When set, paths
 * that would otherwise ride an existing session — trusted-device account
 * switching, password change — demand a fresh second factor.
 */

export async function isRequire2FA(userId: string): Promise<boolean> {
  const sec = await prisma.userSecurity
    .findUnique({ where: { userId }, select: { require2FA: true, totpEnabled: true } })
    .catch(() => null);
  return !!(sec?.require2FA && sec.totpEnabled);
}

/** Returns a ready-to-send rejection response when the account demands a
 *  fresh second factor and the request's proof is missing or wrong — `null`
 *  means the second factor is not required or was satisfied. */
export async function secondFactorBlocker(userId: string, body: any): Promise<NextResponse | null> {
  if (!(await isRequire2FA(userId))) return null;

  const sec = await prisma.userSecurity.findUnique({
    where: { userId },
    select: { totpSecret: true, backupCodes: true },
  });
  if (!sec?.totpSecret) return null;

  const providedCode = typeof (body?.code ?? body?.totpCode) === 'string';
  const code = normalizeTotpCode(body?.code ?? body?.totpCode);
  if (code && (await verifyTotp(code, sec.totpSecret))) return null;

  const backup = typeof body?.backupCode === 'string' ? body.backupCode.trim() : '';
  if (backup) {
    const backupCodes = Array.isArray(sec.backupCodes) ? (sec.backupCodes as any[]) : [];
    const inputHash = hashRecoveryCode(backup);
    const idx = backupCodes.findIndex((c: any) => c?.code === inputHash && !c?.used);
    if (idx !== -1) {
      // Atomic single-use, same shape as recovery2faLoginHandler.
      const updated = await prisma.userSecurity.updateMany({
        where: { userId, backupCodes: { array_contains: [backupCodes[idx]] } as any },
        data: {
          backupCodes: backupCodes.map((c: any) =>
            c?.code === inputHash ? { ...c, used: true, usedAt: new Date().toISOString() } : c
          ) as any,
        },
      });
      if (updated.count === 1) return null;
    }
  }

  if (providedCode || backup) {
    return NextResponse.json({ error: 'INVALID_CODE', requires2FA: true, message: 'Invalid code. Please try again.' }, { status: 400 });
  }
  return NextResponse.json({ error: 'SECOND_FACTOR_REQUIRED', requires2FA: true, message: 'Enter your authenticator code to continue.' }, { status: 403 });
}
