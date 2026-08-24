import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { getSession } from '../../../../lib/session';
import { createAuditEvent } from '../../../../lib/audit';
import { jsonUnauthorized } from '../../../../lib/response';
import { generateRecoveryCodes } from '../../../../lib/auth/totp';
import { hashRecoveryCode } from '../../../../lib/auth/password';

// Backup codes live on users.backup_codes: [{ code: <hash>, used: boolean }]
// Codes are stored hashed; plaintext is shown exactly once at generation time.

// GET /api/security/backup-codes - Status only (codes are hashed at rest)
export async function GET(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { backupCodes: true },
  });
  const codes = Array.isArray((user as any)?.backupCodes) ? (user as any).backupCodes as any[] : [];
  const unused = codes.filter((c) => c && c.used !== true).length;

  return NextResponse.json({
    total: codes.length,
    count: unused,
    enabled: codes.length > 0,
  });
}

// POST /api/security/backup-codes - Regenerate backup codes
export async function POST(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  const newCodes = generateRecoveryCodes(8);

  await prisma.user.update({
    where: { id: session.userId },
    data: {
      backupCodes: newCodes.map((code) => ({ code: hashRecoveryCode(code), used: false })),
    },
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'backup_codes.regenerated',
    targetType: 'user',
    targetId: session.userId,
    severity: 'info',
  });

  return NextResponse.json({
    codes: newCodes,
    count: newCodes.length,
    message: 'Backup codes regenerated. Save these codes in a safe place.',
  });
}
