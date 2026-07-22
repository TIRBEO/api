import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/session';
import { prisma } from '../../../../lib/db/prisma';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const theme = await prisma.themeConfig.findFirst({ where: { isActive: true } });
  if (!theme) {
    return NextResponse.json(getDefaultTheme());
  }
  return NextResponse.json(theme);
}

export async function PUT(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const { id, ...data } = body;

  if (id) {
    const updated = await prisma.themeConfig.update({ where: { id }, data });
    return NextResponse.json(updated);
  } else {
    await prisma.themeConfig.updateMany({ where: { isActive: true }, data: { isActive: false } });
    const created = await prisma.themeConfig.create({ data: { ...data, isActive: true } });
    return NextResponse.json(created);
  }
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json();

  await prisma.themeConfig.updateMany({ where: { isActive: true }, data: { isActive: false } });
  const theme = await prisma.themeConfig.create({ data: { ...body, isActive: true } });
  return NextResponse.json(theme);
}

export async function DELETE(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing theme id' }, { status: 400 });
  }

  const theme = await prisma.themeConfig.findUnique({ where: { id } });
  if (!theme) {
    return NextResponse.json({ error: 'Theme not found' }, { status: 404 });
  }
  if (theme.isActive) {
    return NextResponse.json({ error: 'Cannot delete the active theme' }, { status: 400 });
  }

  await prisma.themeConfig.delete({ where: { id } });
  return NextResponse.json({ success: true });
}

function getDefaultTheme() {
  return {
    id: 'default',
    name: 'default',
    isActive: true,
    bgPrimary: '#08150F',
    bgSecondary: '#101c13',
    bgCard: '#12271D',
    bgElevated: '#1a3326',
    textPrimary: '#F2EEE8',
    textSecondary: '#B7C6BE',
    textMuted: '#6b8a7a',
    accentPrimary: '#569578',
    accentSecondary: '#275d46',
    accentHover: '#6aab8d',
    success: '#59C173',
    warning: '#F4B942',
    error: '#E45D5D',
    borderColor: 'rgba(255,255,255,0.08)',
    borderHover: 'rgba(255,255,255,0.14)',
    fontPrimary: 'Inter',
    fontHeading: 'Plus Jakarta Sans',
    borderRadius: '16px',
    brandName: 'Tirbeo',
    brandTagline: 'Premium Social Platform',
    emailHeaderBg: 'linear-gradient(135deg,#022B22,#275D46,#569578)',
    emailButtonColor: '#569578',
    emailTextColor: '#B7C6BE',
  };
}
