/**
 * Unit tests for the data-usage / cookie choices (features/preferences/dataUsage).
 *
 * Prisma and the auth guards are stubbed — pure unit tests, no database.
 * These pin the promise the settings screen makes: the four toggles persist
 * on the account (so a different browser reads the same answers), unknown or
 * wrongly-typed keys are refused instead of silently dropped, the marketing
 * dependency is enforced server-side, and the write answers with the FULL
 * merged set so the screen settles on the stored truth.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/infrastructure/db/prisma', () => {
  const rows = new Map<string, any>();
  const userPreferences = {
    findUnique: vi.fn(async ({ where }: any) => rows.get(where.userId) ?? null),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const next = rows.has(where.userId) ? { ...rows.get(where.userId), ...update } : { ...create };
      rows.set(where.userId, next);
      return next;
    }),
  };
  return { prisma: { userPreferences } };
});

vi.mock('@/features/auth/http-guards', () => ({
  getSession: vi.fn(async () => ({ userId: 'u1', email: 'e@u.dev' })),
}));

import { prisma } from '@/infrastructure/db/prisma';
import {
  DATA_USAGE_DEFAULTS,
  dataUsageHandler,
  loadDataUsagePrefs,
  saveDataUsagePrefs,
  unknownDataUsageKeys,
} from '@/features/preferences/dataUsage';

const mockFindUnique = prisma.userPreferences.findUnique as ReturnType<typeof vi.fn>;
const mockUpsert = prisma.userPreferences.upsert as ReturnType<typeof vi.fn>;

function freshTable(seedData: Record<string, any> = {}) {
  const rows = new Map<string, any>(Object.entries(seedData));
  mockFindUnique.mockImplementation(async ({ where }: any) => rows.get(where.userId) ?? null);
  mockUpsert.mockImplementation(async ({ where, create, update }: any) => {
    const next = rows.has(where.userId) ? { ...rows.get(where.userId), ...update } : { ...create };
    rows.set(where.userId, next);
    return next;
  });
  return rows;
}

function put(path: string, method = 'GET', body?: unknown) {
  return new NextRequest(`https://api.tirbeo.com${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
}

describe('loadDataUsagePrefs', () => {
  beforeEach(() => freshTable());

  it('answers the defaults for an account that has never been asked', async () => {
    expect(await loadDataUsagePrefs('nobody')).toEqual(DATA_USAGE_DEFAULTS);
  });

  it('returns the stored answers, not the defaults', async () => {
    freshTable({
      u1: { privacy: { dataUsage: { personalised: false, shareWithPartners: true, analyticsCookies: false, marketingCookies: false } } },
    });
    const prefs = await loadDataUsagePrefs('u1');
    expect(prefs.personalised).toBe(false);
    expect(prefs.shareWithPartners).toBe(true);
    expect(prefs.analyticsCookies).toBe(false);
  });

  it('ignores non-boolean junk left in the blob', async () => {
    freshTable({ u1: { privacy: { dataUsage: { personalised: 'yes', analyticsCookies: 1 } } } });
    const prefs = await loadDataUsagePrefs('u1');
    expect(prefs.personalised).toBe(DATA_USAGE_DEFAULTS.personalised);
    expect(prefs.analyticsCookies).toBe(DATA_USAGE_DEFAULTS.analyticsCookies);
  });
});

describe('saveDataUsagePrefs', () => {
  beforeEach(() => freshTable());

  it('persists a patch on the account row and returns the full merged set', async () => {
    const rows = freshTable();
    const { prefs, rejected } = await saveDataUsagePrefs('u1', { shareWithPartners: true });
    expect(rejected).toEqual([]);
    expect(prefs.shareWithPartners).toBe(true);
    expect(rows.get('u1').privacy.dataUsage.shareWithPartners).toBe(true);
    // Untouched keys keep their stored (default) value, not undefined.
    expect(prefs.personalised).toBe(DATA_USAGE_DEFAULTS.personalised);
  });

  it('enforces the marketing-depends-on-analytics rule server-side', async () => {
    const { prefs } = await saveDataUsagePrefs('u1', { analyticsCookies: false, marketingCookies: true });
    expect(prefs.analyticsCookies).toBe(false);
    expect(prefs.marketingCookies).toBe(false);
  });

  it('keeps the other keys of the privacy blob it shares the column with', async () => {
    const rows = freshTable({ u1: { privacy: { allowAnalytics: true, allowCrashReports: false } } });
    await saveDataUsagePrefs('u1', { personalised: false });
    expect(rows.get('u1').privacy.allowAnalytics).toBe(true);
    expect(rows.get('u1').privacy.allowCrashReports).toBe(false);
    expect(rows.get('u1').privacy.dataUsage.personalised).toBe(false);
  });

  it('reports keys it refused because the value is not a yes/no', async () => {
    const { prefs, rejected } = await saveDataUsagePrefs('u1', { personalised: 'on' } as any);
    expect(rejected).toEqual(['personalised']);
    expect(prefs.personalised).toBe(DATA_USAGE_DEFAULTS.personalised);
  });

  it('never stores a key outside the four it owns', async () => {
    const rows = freshTable();
    const { prefs } = await saveDataUsagePrefs('u1', { emailPaused: false, bogus: 1 } as any);
    expect(prefs).not.toHaveProperty('emailPaused');
    expect(rows.get('u1').privacy.dataUsage).not.toHaveProperty('bogus');
  });
});

describe('unknownDataUsageKeys', () => {
  it('names every key that is not one of the four', () => {
    expect(unknownDataUsageKeys({ personalised: true, bogus: 1, alsoBogus: 2 })).toEqual(['bogus', 'alsoBogus']);
    expect(unknownDataUsageKeys({ ...DATA_USAGE_DEFAULTS })).toEqual([]);
  });
});

describe('dataUsageHandler', () => {
  beforeEach(() => freshTable());

  it('GET answers the stored set directly (no wrapper to miss)', async () => {
    const res = await dataUsageHandler(put('/api/preferences/data-usage'));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.marketingCookies).toBe(false);
    expect(body.analyticsCookies).toBe(true);
  });

  it('PUT writes and answers with the FULL merged set', async () => {
    const res = await dataUsageHandler(put('/api/preferences/data-usage', 'PUT', { personalised: false }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.personalised).toBe(false);
    expect(body.analyticsCookies).toBe(true);
  });

  it('PUT refuses an unknown key rather than dropping it quietly', async () => {
    const res = await dataUsageHandler(put('/api/preferences/data-usage', 'PUT', { notifications: true }));
    expect(res.status).toBe(400);
  });

  it('PUT refuses a non-boolean value and keeps the old one', async () => {
    await saveDataUsagePrefs('u1', { marketingCookies: false });
    const res = await dataUsageHandler(put('/api/preferences/data-usage', 'PUT', { marketingCookies: 'true' }));
    expect(res.status).toBe(400);
    expect((await loadDataUsagePrefs('u1')).marketingCookies).toBe(false);
  });
});
