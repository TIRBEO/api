import { Prisma } from '@prisma/client';
import { prisma } from '@/infrastructure/db/prisma';
import { getAccountsBaseUrl } from '@/config/app-urls';

export const LANDING_PAGE_SLUG = 'home';

export const LANDING_SECTION_TYPES = [
  'hero',
  'statement',
  'features',
  'timeline',
  'cta',
  'waitlist',
  'footer',
] as const;

export type LandingSectionType = (typeof LANDING_SECTION_TYPES)[number];

export interface LandingLink {
  label: string;
  href: string;
}

export interface LandingSection {
  id: string;
  type: LandingSectionType;
  visible: boolean;
  props: Record<string, unknown>;
}

export interface LandingConfig {
  version: 1;
  meta: {
    title: string;
    description: string;
  };
  theme: {
    primaryColor: string;
    accentColor: string;
    surfaceColor: string;
  };
  brand: {
    name: string;
    logoUrl: string;
    supportUrl: string;
    loginUrl: string;
  };
  navigation: LandingLink[];
  sections: LandingSection[];
}

const DEFAULT_LOGIN_URL = getAccountsBaseUrl() + '/login';

export const DEFAULT_LANDING_CONFIG: LandingConfig = {
  version: 1,
  meta: {
    title: 'Tirbeo — Technology built around people.',
    description: 'Tirbeo is an independent technology company building useful, human-centered products and systems.',
  },
  theme: {
    primaryColor: '#D4F96A',
    accentColor: '#9DBDFF',
    surfaceColor: '#101010',
  },
  brand: {
    name: 'Tirbeo',
    logoUrl: '',
    supportUrl: 'https://support.tirbeo.app',
    loginUrl: DEFAULT_LOGIN_URL,
  },
  navigation: [
    { label: 'About', href: '#about' },
    { label: 'What we do', href: '#work' },
    { label: 'Our approach', href: '#approach' },
  ],
  sections: [
    {
      id: 'hero',
      type: 'hero',
      visible: true,
      props: {
        eyebrow: 'Independent technology company',
        title: 'Build for people.\nThink beyond products.',
        body: 'Tirbeo creates products, systems, and experiments that make technology feel more useful, more considered, and more human.',
        primaryCtaLabel: 'Explore our work',
        primaryCtaHref: '#work',
        secondaryCtaLabel: 'Our approach',
        secondaryCtaHref: '#approach',
        statValue: '2026',
        statLabel: 'Building the next chapter',
      },
    },
    {
      id: 'statement',
      type: 'statement',
      visible: true,
      props: {
        id: 'about',
        eyebrow: 'Our point of view',
        title: 'Technology should create more room for people to do meaningful work.',
        body: 'We believe the best technology is calm, clear, and built with care. That belief guides every product, partnership, and experiment we take on.',
        label: 'A long-term company, built deliberately.',
      },
    },
    {
      id: 'features',
      type: 'features',
      visible: true,
      props: {
        id: 'work',
        eyebrow: 'What we build',
        title: 'A home for useful ideas.',
        body: 'We work across collaboration, systems, and emerging technology. Each effort starts with a real human problem and earns its place through clarity and craft.',
        items: [
          { number: '01', title: 'Products', body: 'Purposeful software that helps people communicate, organize, and make progress together.' },
          { number: '02', title: 'Platforms', body: 'Reliable foundations that make complex work simpler for teams and communities.' },
          { number: '03', title: 'Experiments', body: 'New directions worth exploring before they become the next enduring thing.' },
        ],
      },
    },
    {
      id: 'timeline',
      type: 'timeline',
      visible: true,
      props: {
        id: 'approach',
        eyebrow: 'How we work',
        title: 'Patient by design.',
        body: 'We make room to understand the problem, build the right foundation, and keep improving after launch.',
        items: [
          { number: '01', title: 'Listen closely', body: 'Start with the people, context, and constraints behind the opportunity.' },
          { number: '02', title: 'Make the essential', body: 'Turn the strongest insight into a clear, useful, durable experience.' },
          { number: '03', title: 'Grow with intent', body: 'Learn in public, improve continuously, and choose long-term value over noise.' },
        ],
      },
    },
    {
      id: 'cta',
      type: 'cta',
      visible: true,
      props: {
        eyebrow: 'The next chapter',
        title: 'We are building what comes next.',
        body: 'Follow along as Tirbeo turns its ideas into products, platforms, and companies.',
        ctaLabel: 'Stay connected',
        ctaHref: '#waitlist',
      },
    },
    {
      id: 'waitlist',
      type: 'waitlist',
      visible: true,
      props: {
        id: 'waitlist',
        eyebrow: 'Stay connected',
        title: 'Get updates from Tirbeo.',
        body: 'Occasional notes about our work, new launches, and what we are learning along the way.',
        buttonLabel: 'Join the list',
        privacyNote: 'No noise. Just occasional updates from Tirbeo.',
      },
    },
    {
      id: 'footer',
      type: 'footer',
      visible: true,
      props: {
        tagline: 'A technology company building useful things for people.',
        copyright: '© 2026 Tirbeo. All rights reserved.',
        links: [
          { label: 'Privacy', href: '/privacy' },
          { label: 'Terms', href: '/terms' },
          { label: 'Cookies', href: '/cookies' },
        ],
      },
    },
  ],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : fallback;
}

function asLinkList(value: unknown, fallback: LandingLink[], max = 12): LandingLink[] {
  if (!Array.isArray(value)) return fallback;
  const links = value.slice(0, max).flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    const label = asText(record.label, '', 80);
    const href = asText(record.href, '', 2_000);
    return label && href ? [{ label, href }] : [];
  });
  return links.length ? links : fallback;
}

function asSections(value: unknown): LandingSection[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) return null;
  const sections: LandingSection[] = [];
  const seenIds = new Set<string>();

  for (const entry of value) {
    const record = asRecord(entry);
    if (!record || typeof record.type !== 'string' || !LANDING_SECTION_TYPES.includes(record.type as LandingSectionType)) {
      return null;
    }
    const id = asText(record.id, '', 80).replace(/[^a-zA-Z0-9_-]/g, '');
    const props = asRecord(record.props);
    if (!id || seenIds.has(id) || !props) return null;
    seenIds.add(id);
    sections.push({
      id,
      type: record.type as LandingSectionType,
      visible: record.visible !== false,
      props,
    });
  }

  return sections;
}

/**
 * Normalizes editor input into a public-safe landing configuration. Unknown
 * top-level fields are intentionally dropped so a landing draft cannot become
 * a channel for private values on the public endpoint.
 */
export function normalizeLandingConfig(value: unknown): LandingConfig {
  const input = asRecord(value) || {};
  const meta = asRecord(input.meta) || {};
  const theme = asRecord(input.theme) || {};
  const brand = asRecord(input.brand) || {};
  const sections = asSections(input.sections) || DEFAULT_LANDING_CONFIG.sections;

  return {
    version: 1,
    meta: {
      title: asText(meta.title, DEFAULT_LANDING_CONFIG.meta.title, 140),
      description: asText(meta.description, DEFAULT_LANDING_CONFIG.meta.description, 400),
    },
    theme: {
      primaryColor: asText(theme.primaryColor, DEFAULT_LANDING_CONFIG.theme.primaryColor, 32),
      accentColor: asText(theme.accentColor, DEFAULT_LANDING_CONFIG.theme.accentColor, 32),
      surfaceColor: asText(theme.surfaceColor, DEFAULT_LANDING_CONFIG.theme.surfaceColor, 32),
    },
    brand: {
      name: asText(brand.name, DEFAULT_LANDING_CONFIG.brand.name, 80),
      logoUrl: asText(brand.logoUrl, DEFAULT_LANDING_CONFIG.brand.logoUrl, 2_000),
      supportUrl: asText(brand.supportUrl, DEFAULT_LANDING_CONFIG.brand.supportUrl, 2_000),
      loginUrl: asText(brand.loginUrl, DEFAULT_LOGIN_URL, 2_000),
    },
    navigation: asLinkList(input.navigation, DEFAULT_LANDING_CONFIG.navigation),
    sections,
  };
}

function toJson(config: LandingConfig): Prisma.InputJsonValue {
  return config as unknown as Prisma.InputJsonValue;
}

export async function getOrCreateLandingPage() {
  return prisma.landingPage.upsert({
    where: { slug: LANDING_PAGE_SLUG },
    create: {
      slug: LANDING_PAGE_SLUG,
      draft: toJson(DEFAULT_LANDING_CONFIG),
    },
    update: {},
  });
}

export async function getLandingDraft() {
  const page = await getOrCreateLandingPage();
  return {
    page,
    config: normalizeLandingConfig(page.draft),
  };
}

export async function getPublishedLandingConfig(): Promise<LandingConfig> {
  const page = await prisma.landingPage.findUnique({
    where: { slug: LANDING_PAGE_SLUG },
    select: { publishedConfig: true },
  });
  return normalizeLandingConfig(page?.publishedConfig || DEFAULT_LANDING_CONFIG);
}

export async function saveLandingDraft(config: unknown, editedBy: string) {
  const normalized = normalizeLandingConfig(config);
  const page = await getOrCreateLandingPage();
  const updated = await prisma.landingPage.update({
    where: { id: page.id },
    data: {
      draft: toJson(normalized),
      editedBy,
      draftVersion: { increment: 1 },
    },
  });

  return {
    page: updated,
    config: normalized,
  };
}

export async function publishLandingDraft(publishedBy: string) {
  const page = await getOrCreateLandingPage();
  const config = normalizeLandingConfig(page.draft);
  const version = Math.max(page.draftVersion, (page.publishedVersion || 0) + 1);
  const publishedAt = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    await tx.landingPagePublication.create({
      data: {
        landingPageId: page.id,
        version,
        config: toJson(config),
        publishedBy,
        publishedAt,
      },
    });

    return tx.landingPage.update({
      where: { id: page.id },
      data: {
        publishedConfig: toJson(config),
        publishedVersion: version,
        publishedAt,
      },
    });
  });

  return {
    page: updated,
    config,
  };
}
