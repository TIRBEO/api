import { prisma } from '@/infrastructure/db/prisma';

// Platform-wide category switches, one AppConfig JSON row — same 'email.*'
// key convention and read style as 'email.config' in email.ts.
const SWITCHES_KEY = 'email.category_switches';

// `type` not `interface` — Prisma's Json input requires the implicit index signature.
export type GlobalEmailSwitches = {
  productUpdates: boolean;
  offersPromos: boolean;
  tips: boolean;
};

// Mail nobody can switch off is mail we should not be sending until the switch exists.
const DEFAULTS: GlobalEmailSwitches = {
  productUpdates: false,
  offersPromos: false,
  tips: true,
};

// getEmailConfig reads the row fresh on every send and is not cached, so this
// matches it rather than inventing a cache layer.
export async function getGlobalEmailSwitches(): Promise<GlobalEmailSwitches> {
  const switches = { ...DEFAULTS };
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: SWITCHES_KEY } });
    const value = row?.value as Record<string, unknown> | null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(DEFAULTS) as (keyof GlobalEmailSwitches)[]) {
        if (typeof value[key] === 'boolean') switches[key] = value[key] as boolean;
      }
    }
  } catch (e: any) {
    console.warn('[EMAIL] Failed to load category switches from AppConfig:', e?.message);
  }
  return switches;
}

/** Which platform switch a mail category falls under. */
export const SWITCH_BY_CATEGORY: Record<string, keyof GlobalEmailSwitches> = {
  product: 'productUpdates',
  offers: 'offersPromos',
  promotions: 'offersPromos',
  tips: 'tips',
};

export async function setGlobalEmailSwitches(
  patch: Partial<GlobalEmailSwitches>,
): Promise<GlobalEmailSwitches> {
  const current = await getGlobalEmailSwitches();
  const next: GlobalEmailSwitches = { ...current };
  for (const key of Object.keys(DEFAULTS) as (keyof GlobalEmailSwitches)[]) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key] as boolean;
  }
  await prisma.appConfig.upsert({
    where: { key: SWITCHES_KEY },
    update: { value: next },
    create: {
      key: SWITCHES_KEY,
      value: next,
      description: 'Global per-category email switches (platform-wide)',
    },
  });
  return next;
}
