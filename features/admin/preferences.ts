import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/infrastructure/db/prisma';
import { getSessionOrResponse } from '@/features/auth/http-guards';

/* What an operator prefers, on the account rather than in this browser.
 *
 * Theme and density already worked — in `localStorage`, on one device. Storing
 * the same three choices on the account is what makes a second device open the
 * way the first was left, which is the entire difference between a preference
 * and a setting. The browser copy does not go away: it is what paints before
 * the first request returns, so it stays as a cache of the server's answer and
 * never as the answer itself.
 *
 * Three fields, because three are what the console can actually render:
 * theme, density and page size. Language is not one of them — there is one
 * language, and a selector that lists one option is a control that does nothing
 * except imply that something else is possible. It comes back the day the
 * translations do.
 */

const THEMES = ['light', 'dark', 'system'] as const;
const DENSITIES = ['comfortable', 'compact'] as const;
const PAGE_SIZES = [25, 50, 100] as const;

export type Appearance = {
  theme: (typeof THEMES)[number];
  density: (typeof DENSITIES)[number];
  pageSize: (typeof PAGE_SIZES)[number];
};

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', density: 'comfortable', pageSize: 25 };

const patchSchema = z.object({
  theme: z.enum(THEMES).optional(),
  density: z.enum(DENSITIES).optional(),
  pageSize: z.number().int().refine((n) => (PAGE_SIZES as readonly number[]).includes(n)).optional(),
});

/** The stored shape is a JSON blob an earlier version of this product wrote
 *  from a different screen, so every read coerces rather than trusting it. A
 *  row containing `{theme: 'midnight'}` is not a licence to send a value the
 *  console has no CSS for. */
export function coerceAppearance(raw: unknown): Appearance {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    theme: (THEMES as readonly string[]).includes(String(value.theme)) ? value.theme as Appearance['theme'] : DEFAULT_APPEARANCE.theme,
    density: (DENSITIES as readonly string[]).includes(String(value.density)) ? value.density as Appearance['density'] : DEFAULT_APPEARANCE.density,
    pageSize: (PAGE_SIZES as readonly number[]).includes(Number(value.pageSize)) ? Number(value.pageSize) as Appearance['pageSize'] : DEFAULT_APPEARANCE.pageSize,
  };
}

/** One read, for the `/admin/me` answer the console boots from. */
export async function readAppearance(userId: string): Promise<Appearance> {
  const row = await prisma.userPreferences.findUnique({
    where: { userId },
    select: { appearance: true },
  });
  return coerceAppearance(row?.appearance);
}

export async function getAppearance(request: NextRequest) {
  const session = await getSessionOrResponse(request);
  if (session instanceof NextResponse) return session;
  return NextResponse.json({ appearance: await readAppearance(session.userId) }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function patchAppearance(request: NextRequest) {
  const session = await getSessionOrResponse(request);
  if (session instanceof NextResponse) return session;

  const parsed = patchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({
      error: 'theme is light, dark or system; density is comfortable or compact; pageSize is 25, 50 or 100.',
    }, { status: 400 });
  }
  if (!Object.keys(parsed.data).length) {
    return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 });
  }

  // Read-modify-write: `appearance` also holds the theme and timezone the
  // account's own profile screen set, and a write of the whole blob from the
  // console would erase them.
  const next = await prisma.$transaction(async (tx) => {
    const row = await tx.userPreferences.findUnique({ where: { userId: session.userId }, select: { appearance: true } });
    const current = row?.appearance && typeof row.appearance === 'object' && !Array.isArray(row.appearance)
      ? row.appearance as Record<string, unknown>
      : {};
    const merged = { ...current, ...parsed.data };
    await tx.userPreferences.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId, appearance: merged },
      update: { appearance: merged },
    });
    return coerceAppearance(merged);
  });

  return NextResponse.json({ appearance: next });
}
