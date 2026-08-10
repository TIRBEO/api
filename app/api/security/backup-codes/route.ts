import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';
import { getSession } from '../../../../lib/session';
import { createAuditEvent } from '../../../../lib/audit';
import { jsonUnauthorized } from '../../../../lib/response';
import crypto from 'crypto';

function generateBackupCode(): string {
  const bytes = crypto.randomBytes(5);
  const hex = Buffer.from(bytes).toString('hex').toUpperCase();
  const parts = hex.match(/.{1,4}/g) || [];
  return parts.join('-');
}

// GET /api/security/backup-codes - List backup codes
export async function GET(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  const codes = await prisma.recoveryCode.findMany({
    where: { userId: session.userId },
    select: { id: true, code: true, used: true, createdAt: true, usedAt: true },
    orderBy: { createdAt: 'desc' },
  });

  const count = codes.filter(c => !c.used).length;

  return NextResponse.json({
    codes: codes.map(c => ({
      id: c.id,
      code: c.used ? '****-****' : c.code,
      used: c.used || false,
      usedAt: c.usedAt,
      createdAt: c.createdAt,
    })),
    count,
    enabled: count > 0,
  });
}

// POST /api/security/backup-codes - Regenerate backup codes
export async function POST(request: NextRequest) {
  const session = await getSession(request);
  if (!session) return jsonUnauthorized();

  // Delete old codes
  await prisma.recoveryCode.deleteMany({
    where: { userId: session.userId },
  });

  // Generate new codes
  const newCodes = Array.from({ length: 10 }, () => generateBackupCode());
  
  await prisma.recoveryCode.createMany({
    data: newCodes.map(code => ({
      userId: session.userId,
      code,
      used: false,
    })),
  });

  // Audit event
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
