export interface Branding {
  logoUrl: string;
  brandName: string;
  brandTagline: string;
  emailFromName: string;
  emailFromAddress: string;
}

import { getApiBaseUrl } from '@/config/app-urls';

export function getApiOrigin(): string {
  return getApiBaseUrl();
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
  emailFromAddress: 'noreply@tirbeo.com',
};

/** Where an installation's own words for itself live, so the console can change
 *  them without a deploy. Every field is optional in the stored row: a record
 *  half-filled from a console form falls back field by field rather than
 *  blanking a mail header. */
export const BRAND_CONFIG_KEY = 'organization.branding';

/** Only strings with something in them. An empty form field is an unanswered
 *  question, not an instruction to mail people from an empty address. */
function usable(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' && raw.trim()) out[key] = raw.trim();
  }
  return out;
}

export async function getBranding(): Promise<Branding> {
  const fromEnv: Branding = {
    ...DEFAULT_BRANDING,
    logoUrl: resolveLogoUrl(process.env.TIRBEO_LOGO_URL),
  };

  let stored: Record<string, string> = {};
  try {
    const { prisma } = await import('@/infrastructure/db/prisma');
    const row = await prisma.appConfig.findUnique({ where: { key: BRAND_CONFIG_KEY }, select: { value: true } });
    stored = usable(row?.value);
  } catch {
    // A branding read that fails must not take the mail send or the public
    // endpoint with it — the defaults above are a complete answer on their own.
  }

  const merged = { ...fromEnv, ...stored } as Branding;
  // A stored logo is a path or a URL the operator typed, and it means the same
  // thing here as the env value did one line up.
  return stored.logoUrl ? { ...merged, logoUrl: resolveLogoUrl(stored.logoUrl) } : merged;
}
