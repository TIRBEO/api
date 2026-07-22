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
      '--bg': theme.bgPrimary,
      '--bg-surface': theme.bgSecondary,
      '--bg-card': theme.bgCard,
      '--bg-elevated': theme.bgElevated,
      '--text': theme.textPrimary,
      '--text-secondary': theme.textSecondary,
      '--text-muted': theme.textMuted,
      '--accent': theme.accentPrimary,
      '--accent-hover': theme.accentHover,
      '--accent-muted': theme.accentSecondary,
      '--success': theme.success,
      '--warning': theme.warning,
      '--danger': theme.error,
      '--border': theme.borderColor,
      '--border-hover': theme.borderHover,
      '--font-primary': theme.fontPrimary,
      '--font-heading': theme.fontHeading,
      '--radius': theme.borderRadius,
      '--logo-url': theme.logoUrl || '',
      '--brand-name': theme.brandName,
      '--email-header-bg': theme.emailHeaderBg,
      '--email-button-color': theme.emailButtonColor,
      '--email-text-color': theme.emailTextColor,
    };

    if (theme.lightBgPrimary) colors['--light-bg'] = theme.lightBgPrimary;
    if (theme.lightBgSecondary) colors['--light-bg-surface'] = theme.lightBgSecondary;
    if (theme.lightTextPrimary) colors['--light-text'] = theme.lightTextPrimary;
    if (theme.lightAccentPrimary) colors['--light-accent'] = theme.lightAccentPrimary;

    return NextResponse.json({
      active: true,
      colors,
      brand: {
        name: theme.brandName,
        tagline: theme.brandTagline,
        logo: theme.logoUrl,
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
