import { NextResponse } from 'next/server';
import { getBranding, type Branding } from '../../../../lib/branding';
import { cachedJson } from '../../../../lib/response';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const branding = await getBranding();
    
    // Return public-safe branding data
    const publicBranding: Record<string, unknown> = {
      logoUrl: branding.logoUrl,
      brandName: branding.brandName,
      brandTagline: branding.brandTagline,
      faviconUrl: branding.logoUrl,
      primaryColor: '#3b82f6',
      emailFromName: branding.emailFromName,
      emailFromAddress: branding.emailFromAddress,
    };

    return cachedJson(publicBranding, { ttl: 60, swr: 300 });
  } catch (err: any) {
    console.error('[PUBLIC BRANDING]', err?.message || err);
    // Return defaults on error
    return cachedJson({
      logoUrl: '',
      brandName: 'Tirbeo',
      brandTagline: 'Premium Social Platform',
      faviconUrl: '',
      primaryColor: '#3b82f6',
      emailFromName: 'Tirbeo',
      emailFromAddress: 'noreply@send.tirbeo.app',
    }, { ttl: 60 });
  }
}
