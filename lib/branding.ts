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

// Always resolve logo to the public /logo.png served by the API
function resolveLogoUrl(raw?: string | null): string {
  if (raw && /^(https?:\/\/|data:image\/|\/\/)/i.test(String(raw).trim())) {
    return String(raw).trim();
  }
  return `${getApiOrigin()}/logo.png`;
}

const DEFAULT_BRANDING: Branding = {
  logoUrl: '',
  brandName: 'Tirbeo',
  brandTagline: 'The operating system for business automation.',
  emailFromName: 'Tirbeo',
  emailFromAddress: 'noreply@send.tirbeo.app',
};

export async function getBranding(): Promise<Branding> {
  return {
    ...DEFAULT_BRANDING,
    logoUrl: resolveLogoUrl(process.env.TIRBEO_LOGO_URL),
  };
}
