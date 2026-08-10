import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/db/prisma';
import { withAdmin } from '@/lib/role-guard';

export const GET = withAdmin(async (request, session) => {

  const config = await prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (!config) {
    return NextResponse.json({ provider: 'resend', fromEmail: 'noreply@send.tirbeo.app', fromName: 'Tirbeo', enabled: false });
  }
  return NextResponse.json({ ...config, apiKey: config.resendApiKey, fromEmail: config.defaultFromEmail, fromName: config.defaultFromName, enabled: true });
});

export const PUT = withAdmin(async (request, session) => {

  const body: any = await request.json();
  const { provider, apiKey, smtpHost, smtpPort, smtpUser, smtpPass, fromEmail, fromName } = body;

  const data = {
    provider,
    resendApiKey: apiKey || null,
    smtpHost: smtpHost || null,
    smtpPort: smtpPort ? Number(smtpPort) : null,
    smtpUser: smtpUser || null,
    smtpPass: smtpPass || null,
    defaultFromEmail: fromEmail || 'noreply@send.tirbeo.app',
    defaultFromName: fromName || 'Tirbeo',
  };

  let config = await prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (config) {
    config = await prisma.emailConfig.update({ where: { id: config.id }, data });
  } else {
    config = await prisma.emailConfig.create({ data });
  }

  return NextResponse.json({ ...config, apiKey: config.resendApiKey, fromEmail: config.defaultFromEmail, fromName: config.defaultFromName, enabled: true });
});
