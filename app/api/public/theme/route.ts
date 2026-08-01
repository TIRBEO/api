import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const theme = await prisma.themeConfig.findFirst({ where: { isActive: true } });
    if (!theme) {
      return NextResponse.json({ active: false, colors: getDefaultColors() });
    }

    const colors: Record<string, string> = {
      '--bg': theme.bgPrimary || '#08150F',
      '--bg-surface': theme.bgSecondary || '#101c13',
      '--bg-card': theme.bgCard || '#12271D',
      '--bg-elevated': theme.bgElevated || '#1a3326',
      '--text': theme.textPrimary || '#F2EEE8',
      '--text-secondary': theme.textSecondary || '#B7C6BE',
      '--text-muted': theme.textMuted || '#6b8a7a',
      '--accent': theme.accentPrimary || '#569578',
      '--accent-hover': theme.accentHover || '#6aab8d',
      '--accent-muted': theme.accentSecondary || '#275d46',
      '--success': theme.success || '#59C173',
      '--warning': theme.warning || '#F4B942',
      '--danger': theme.error || '#E45D5D',
      '--border': theme.borderColor || 'rgba(255,255,255,0.08)',
      '--border-hover': theme.borderHover || 'rgba(255,255,255,0.14)',
      '--font-primary': theme.fontPrimary || 'Inter',
      '--font-heading': theme.fontHeading || 'Plus Jakarta Sans',
      '--radius': theme.borderRadius || '16px',
      '--logo-url': theme.logoUrl || '',
      '--brand-name': theme.brandName || 'Tirbeo',
      '--email-header-bg': theme.emailHeaderBg || 'linear-gradient(135deg,#022B22,#275D46,#569578)',
      '--email-button-color': theme.emailButtonColor || '#569578',
      '--email-text-color': theme.emailTextColor || '#B7C6BE',
    };

    if (theme.lightBgPrimary) colors['--light-bg'] = theme.lightBgPrimary;
    if (theme.lightBgSecondary) colors['--light-bg-surface'] = theme.lightBgSecondary;
    if (theme.lightTextPrimary) colors['--light-text'] = theme.lightTextPrimary;
    if (theme.lightAccentPrimary) colors['--light-accent'] = theme.lightAccentPrimary;

    return NextResponse.json({
      active: true,
      colors,
      brand: {
        name: theme.brandName || 'Tirbeo',
        tagline: theme.brandTagline || '',
        logo: theme.logoUrl || '',
      },
    });
  } catch {
    return NextResponse.json({ active: false, colors: getDefaultColors() });
  }
}

function getDefaultColors(): Record<string, string> {
  return {
    '--bg': '#08150F',
    '--bg-surface': '#101c13',
    '--bg-card': '#12271D',
    '--bg-elevated': '#1a3326',
    '--text': '#F2EEE8',
    '--text-secondary': '#B7C6BE',
    '--text-muted': '#6b8a7a',
    '--accent': '#569578',
    '--accent-hover': '#6aab8d',
    '--accent-muted': '#275d46',
    '--success': '#59C173',
    '--warning': '#F4B942',
    '--danger': '#E45D5D',
    '--border': 'rgba(255,255,255,0.08)',
    '--border-hover': 'rgba(255,255,255,0.14)',
    '--font-primary': 'Inter',
    '--font-heading': 'Plus Jakarta Sans',
    '--radius': '16px',
    '--email-header-bg': 'linear-gradient(135deg,#022B22,#275D46,#569578)',
    '--email-button-color': '#569578',
    '--email-text-color': '#B7C6BE',
  };
}
