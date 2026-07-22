import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/db/prisma';
import { requireAdmin } from '../../../../../lib/session';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const config = await prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
  return NextResponse.json(config || { provider: 'resend', fromEmail: 'noreply@tirbeo.app', fromName: 'Tirbeo', enabled: false });
}

export async function PUT(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const { provider, apiKey, smtpHost, smtpPort, smtpUser, smtpPass, fromEmail, fromName, enabled } = body;

  let config = await prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (config) {
    config = await prisma.emailConfig.update({
      where: { id: config.id },
      data: { provider, apiKey, smtpHost, smtpPort: smtpPort ? Number(smtpPort) : null, smtpUser, smtpPass, fromEmail, fromName, enabled: enabled ?? true },
    });
  } else {
    config = await prisma.emailConfig.create({
      data: { provider, apiKey, smtpHost, smtpPort: smtpPort ? Number(smtpPort) : null, smtpUser, smtpPass, fromEmail, fromName, enabled: enabled ?? true },
    });
  }

  return NextResponse.json(config);
}
