import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../lib/db/prisma';
import { requireAdmin } from '@/lib/session';

const PROVIDERS = ['slack', 'github', 'discord', 'google', 'gitlab', 'jira', 'notion', 'linear'];

const integrationSchema = z.object({
  userId: z.string().optional(),
  provider: z.enum(['slack', 'github', 'discord', 'google', 'gitlab', 'jira', 'notion', 'linear']),
  connected: z.boolean().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const integrations = await prisma.integration.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { id: true, email: true, name: true } },
    },
  });

  const mapped = integrations.map((i) => ({
    id: i.id,
    provider: i.provider,
    connected: i.connected,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    user: i.user ? { id: i.user.id, email: i.user.email, name: i.user.name } : null,
  }));

  return NextResponse.json({
    integrations: mapped,
    availableProviders: PROVIDERS,
  });
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const parsed = integrationSchema.safeParse(body);
  if (!parsed.success) {
    return new NextResponse('Invalid payload: ' + JSON.stringify(parsed.error.flatten()), { status: 400 });
  }

  const { userId, provider, connected, accessToken, refreshToken, expiresAt, metadata } = parsed.data;

  if (!userId) {
    return new NextResponse('userId is required', { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return new NextResponse('User not found', { status: 404 });

  const integration = await prisma.integration.upsert({
    where: { userId_provider: { userId, provider } },
    update: {
      connected: connected ?? true,
      accessToken: accessToken || undefined,
      refreshToken: refreshToken || undefined,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      metadata: (metadata as any) || undefined,
    },
    create: {
      userId,
      provider,
      connected: connected ?? true,
      accessToken: accessToken || '',
      refreshToken: refreshToken || '',
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      metadata: (metadata as any) || undefined,
    },
  });

  return NextResponse.json(integration, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const { userId, provider } = body;
  if (!userId || !provider) {
    return new NextResponse('userId and provider are required', { status: 400 });
  }

  await prisma.integration.deleteMany({ where: { userId, provider } });
  return new NextResponse('Integration disconnected', { status: 200 });
}
