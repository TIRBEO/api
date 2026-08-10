import { NextRequest, NextResponse } from 'next/server';
import { withAdmin } from '@/lib/role-guard';
import { prisma } from '../../../../lib/db/prisma';

export const GET = withAdmin(async (request, session) => {

  const theme = await prisma.themeConfig.findFirst({ where: { isActive: true } });
  if (!theme) {
    return NextResponse.json(getDefaultTheme());
  }
  return NextResponse.json(theme);
});

export const PUT = withAdmin(async (request, session) => {

  const body: any = await request.json();
  const { id, ...data } = body;

  if (id) {
    const updated = await prisma.themeConfig.update({ where: { id }, data });
    return NextResponse.json(updated);
  } else {
    await prisma.themeConfig.updateMany({ where: { isActive: true }, data: { isActive: false } });
    const created = await prisma.themeConfig.create({ data: { ...data, isActive: true } });
    return NextResponse.json(created);
  }
});

export const POST = withAdmin(async (request, session) => {

  const body: any = await request.json();

  await prisma.themeConfig.updateMany({ where: { isActive: true }, data: { isActive: false } });
  const theme = await prisma.themeConfig.create({ data: { ...body, isActive: true } });
  return NextResponse.json(theme);
});

export const DELETE = withAdmin(async (request, session) => {

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
});

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
    accentPrimary: '#8AB4F8',
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
    emailHeaderBg: 'linear-gradient(135deg,#1A73E8,#4285F4,#8AB4F8)',
    emailButtonColor: '#8AB4F8',
    emailTextColor: '#B7C6BE',
  };
}
