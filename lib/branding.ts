import { prisma } from './db/prisma';

export interface Branding {
  logoUrl: string;
  brandName: string;
  brandTagline: string;
  emailFromName: string;
  emailFromAddress: string;
}

export function getApiOrigin(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, '');
  return process.env.NODE_ENV === 'production' ? 'https://api.tirbeo.app' : 'http://localhost:3000';
}

export function normalizeLogoUrl(raw: string | null | undefined): string {
  if (!raw) return '';
  const value = String(raw).trim();
  if (!value) return '';
  if (/^(https?:\/\/|data:image\/|\/\/)/i.test(value)) return value;
  const cleaned = value.replace(/^\/+/, '');
  const base = getApiOrigin();
  if (/^[a-z0-9][a-z0-9-]*(\.png|\.svg|\.webp)?$/i.test(cleaned)) {
    return `${base}/image/${cleaned.replace(/\.png$/i, '')}.png`;
  }
  return `${base}/${cleaned}`;
}

const CACHE_TTL_MS = 30_000;
let cache: { data: Branding; at: number } | null = null;

const DEFAULT_BRANDING: Branding = {
  logoUrl: '',
  brandName: 'Tirbeo',
  brandTagline: 'The operating system for business automation.',
  emailFromName: 'Tirbeo',
  emailFromAddress: 'noreply@send.tirbeo.app',
};

// Always resolve logo to the public /logo.png served by the API
function resolveLogoUrl(raw?: string | null): string {
  if (raw && /^(https?:\/\/|data:image\/|\/\/)/i.test(String(raw).trim())) {
    return String(raw).trim();
  }
  return `${getApiOrigin()}/logo.png`;
}

export async function getBranding(force = false): Promise<Branding> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;    const defaults: Branding = {
      ...DEFAULT_BRANDING,
      logoUrl: resolveLogoUrl(process.env.TIRBEO_LOGO_URL),
    };

    try {
      const [theme, site, emailConfig] = await Promise.all([
        prisma.themeConfig.findFirst({ where: { isActive: true } }),
        prisma.siteConfig.findUnique({ where: { app: 'brand' } }),
        prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } }),
      ]);

      const siteBrand = (site?.config as Record<string, unknown>) || {};
      const brand = {
        logoUrl: resolveLogoUrl(siteBrand.logoUrl as string | undefined || theme?.logoUrl),
        brandName: (siteBrand.brandName as string) || theme?.brandName || defaults.brandName,
        brandTagline: (siteBrand.brandTagline as string) || theme?.brandTagline || defaults.brandTagline,
        emailFromName: (siteBrand.emailFromName as string) || emailConfig?.defaultFromName || defaults.emailFromName,
        emailFromAddress: (siteBrand.emailFromAddress as string) || emailConfig?.defaultFromEmail || defaults.emailFromAddress,
      };

      cache = { data: brand, at: Date.now() };
      return brand;
    } catch {
      return defaults;
    }
}

export function clearBrandingCache(): void {
  cache = null;
}
