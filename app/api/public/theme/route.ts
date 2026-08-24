import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ active: false, colors: getDefaultColors() });
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
    '--accent': '#8AB4F8',
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
    '--email-header-bg': 'linear-gradient(135deg,#1A73E8,#4285F4,#8AB4F8)',
    '--email-button-color': '#8AB4F8',
    '--email-text-color': '#B7C6BE',
  };
}
