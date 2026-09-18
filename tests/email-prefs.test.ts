/**
 * Unit tests for digest cadence + email suppression logic.
 *
 * Prisma is stubbed so these are pure unit tests — no database or network
 * access. `emailPrefs.ts` imports `db/prisma` and `app-urls` at module load;
 * `db/prisma` is mocked, and `UNSUBSCRIBE_SECRET` is provided via env.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.UNSUBSCRIBE_SECRET = 'test-secret';

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from '@/infrastructure/db/prisma';
import {
  ESSENTIAL_TEMPLATES,
  shouldSuppressEmail,
  processUnsubscribe,
  isInQuietHours,
} from '@/features/email/emailPrefs';
import { frequencyToMs, isCadenceDue } from '@/jobs/jobs';

const mockFindUnique = prisma.user.findUnique as ReturnType<typeof vi.fn>;

// ─── Digest cadence ────────────────────────────────────────────────

describe('frequencyToMs', () => {
  it('maps daily to 1 day', () => {
    expect(frequencyToMs('daily')).toBe(86_400_000);
  });

  it('maps weekly to 7 days', () => {
    expect(frequencyToMs('weekly')).toBe(7 * 86_400_000);
  });

  it('maps monthly to 30 days', () => {
    expect(frequencyToMs('monthly')).toBe(30 * 86_400_000);
  });

  it('defaults unknown/null/undefined to daily', () => {
    expect(frequencyToMs(null)).toBe(86_400_000);
    expect(frequencyToMs(undefined)).toBe(86_400_000);
    expect(frequencyToMs('bogus')).toBe(86_400_000);
  });
});

describe('isCadenceDue', () => {
  const now = new Date('2026-09-13T12:00:00Z');

  it('is due when never sent', () => {
    expect(isCadenceDue(null, now, frequencyToMs('daily'))).toBe(true);
    expect(isCadenceDue(undefined, now, frequencyToMs('daily'))).toBe(true);
  });

  it('daily: due after 24h, not due before', () => {
    const day = frequencyToMs('daily');
    expect(isCadenceDue(new Date(now.getTime() - day).toISOString(), now, day)).toBe(true);
    expect(isCadenceDue(new Date(now.getTime() - day + 60_000).toISOString(), now, day)).toBe(false);
  });

  it('weekly: due after 7 days, not due before', () => {
    const week = frequencyToMs('weekly');
    expect(isCadenceDue(new Date(now.getTime() - week).toISOString(), now, week)).toBe(true);
    expect(isCadenceDue(new Date(now.getTime() - week + 60_000).toISOString(), now, week)).toBe(false);
  });

  it('monthly: due after 30 days, not due before', () => {
    const month = frequencyToMs('monthly');
    expect(isCadenceDue(new Date(now.getTime() - month).toISOString(), now, month)).toBe(true);
    expect(isCadenceDue(new Date(now.getTime() - month + 60_000).toISOString(), now, month)).toBe(false);
  });

  it('accepts Date objects', () => {
    const day = frequencyToMs('daily');
    expect(isCadenceDue(new Date(now.getTime() - day), now, day)).toBe(true);
  });
});

// ─── Email suppression ─────────────────────────────────────────────

describe('shouldSuppressEmail', () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
  });

  it('never suppresses essential templates (OTP, security, account)', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: false },
      emailUnsubscribed: { all: true },
    });
    for (const template of ['signup_otp', 'login_otp', 'password_reset_link', 'suspicious_login']) {
      expect(ESSENTIAL_TEMPLATES.has(template)).toBe(true);
      expect(await shouldSuppressEmail('user@test.dev', template)).toBe(false);
    }
  });

  it('suppresses everything non-essential when global email toggle is off', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: false, forms: true, formsEmail: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'form_submission_confirmation')).toBe(true);
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(true);
  });

  it('suppresses when category email toggle is off', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, forms: true, formsEmail: false },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'form_submission_confirmation')).toBe(true);
  });

  it('sends when toggles are on', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, forms: true, formsEmail: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'form_submission_confirmation')).toBe(false);
  });

  it('suppresses when globally unsubscribed', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true },
      emailUnsubscribed: { all: true },
    });
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(true);
  });

  it('suppresses when unsubscribed from a specific category', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, productEmail: true },
      emailUnsubscribed: { product: true },
    });
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(true);
  });

  it('handles the tips category with legacy product fallback', async () => {
    // Modern tips prefs off → suppressed
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, tips: false, tipsEmail: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'account_tip')).toBe(true);

    // Legacy fallback: no tips prefs, productEmail off → suppressed
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, productEmail: false },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'account_tip')).toBe(true);

    // tips on → sends
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, tips: true, tipsEmail: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'account_tip')).toBe(false);
  });

  it('never suppresses digest emails on the category check (sweep already gated)', async () => {
    // Digest emails use categoryOverride 'digest': only the global email
    // toggle / global unsubscribe apply, not the product toggle.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, product: false, productEmail: false },
      emailUnsubscribed: null,
    });
    expect(
      await shouldSuppressEmail('user@test.dev', 'notification_digest', 'digest')
    ).toBe(false);
    // But global email off still suppresses the digest
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: false },
      emailUnsubscribed: null,
    });
    expect(
      await shouldSuppressEmail('user@test.dev', 'notification_digest', 'digest')
    ).toBe(true);
  });

  it('honours categoryOverride over the template map (forms digest must respect formsEmail)', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, forms: true, formsEmail: false },
      emailUnsubscribed: null,
    });
    // notification_digest maps to 'product' in TEMPLATE_CATEGORY, but the
    // per-notification email is really a forms email → suppressed via override.
    expect(
      await shouldSuppressEmail('user@test.dev', 'notification_digest', 'forms')
    ).toBe(true);
  });

  it('lets unknown users through (fail-open)', async () => {
    mockFindUnique.mockResolvedValue(null);
    expect(await shouldSuppressEmail('ghost@test.dev', 'product_update')).toBe(false);
  });

  it('treats missing prefs as all-on (defaults)', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: null,
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(false);
  });

  it('suppresses during quiet hours (non-essential only)', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: {
        email: true, productEmail: true,
        quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '08:00',
      },
      emailUnsubscribed: null,
    });

    // 23:30 local — inside the 22:00–08:00 quiet window → suppressed
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T23:30:00'));
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(true);

    // 12:00 — outside the window → sends
    vi.setSystemTime(new Date('2026-09-13T12:00:00'));
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(false);

    vi.useRealTimers();
  });
});

// ─── Quiet hours helper ────────────────────────────────────────────

describe('isInQuietHours', () => {
  it('returns false when disabled or missing', () => {
    expect(isInQuietHours(null)).toBe(false);
    expect(isInQuietHours({ quietHoursEnabled: false })).toBe(false);
    expect(isInQuietHours({})).toBe(false);
  });

  it('handles windows that cross midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T23:00:00')); // inside 22:00–08:00
    expect(isInQuietHours({ quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '08:00' })).toBe(true);
    vi.setSystemTime(new Date('2026-01-15T06:00:00')); // early morning still inside
    expect(isInQuietHours({ quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '08:00' })).toBe(true);
    vi.useRealTimers();
  });

  it('handles windows within the same day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T13:00:00'));
    expect(isInQuietHours({ quietHoursEnabled: true, quietHoursStart: '12:00', quietHoursEnd: '14:00' })).toBe(true);
    expect(isInQuietHours({ quietHoursEnabled: true, quietHoursStart: '14:00', quietHoursEnd: '15:00' })).toBe(false);
    vi.useRealTimers();
  });
});

// ─── Unsubscribe processing ────────────────────────────────────────

describe('processUnsubscribe', () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    (prisma.$executeRaw as ReturnType<typeof vi.fn>).mockReset();
    (prisma.$executeRaw as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  });

  it('ignores attempts to unsubscribe from security (compulsory)', async () => {
    mockFindUnique.mockResolvedValue({
      notificationPreferences: { email: true },
      emailUnsubscribed: { all: true },
    });
    const prefs = await processUnsubscribe('u1', 'security');
    expect(prefs.email).toBe(true);
    // No write executed
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('writes category email toggle + unsub flag', async () => {
    mockFindUnique.mockResolvedValue({
      notificationPreferences: { email: true, productEmail: true },
      emailUnsubscribed: {},
    });
    const prefs = await processUnsubscribe('u1', 'product');
    expect(prefs.productEmail).toBe(false);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("'all' disables the global email toggle", async () => {
    mockFindUnique.mockResolvedValue({
      notificationPreferences: { email: true },
      emailUnsubscribed: {},
    });
    const prefs = await processUnsubscribe('u1', 'all');
    expect(prefs.email).toBe(false);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
