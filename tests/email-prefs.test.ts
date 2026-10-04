/**
 * Unit tests for digest cadence + email suppression logic.
 *
 * Prisma is stubbed so these are pure unit tests — no database or network
 * access. `emailPrefs.ts` imports `db/prisma` and `app-urls` at module load;
 * `db/prisma` is mocked, and `UNSUBSCRIBE_SECRET` is provided via env.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.UNSUBSCRIBE_SECRET = 'test-secret';

vi.mock('@/infrastructure/db/prisma', () => {
  // Tests seed prefs in the legacy `prisma.user.findUnique` fixture shape.
  // The consolidated source reads UserEmail → UserPreferences.notif, so the
  // mock adapts the fixture into those lookups.
  const user = { findUnique: vi.fn() };
  const fixture = async () => (await user.findUnique({ where: { id: '__fixture__' } })) as any;
  return {
    prisma: {
      user,
      userEmail: {
        findFirst: vi.fn(async () => {
          const u = await fixture();
          return u ? { userId: u.id ?? 'u1' } : null;
        }),
      },
      userPreferences: {
        findUnique: vi.fn(async () => {
          const u = await fixture();
          if (!u) return null;
          const notif: Record<string, unknown> = { ...(u.notificationPreferences ?? {}) };
          if (u.emailUnsubscribed && typeof u.emailUnsubscribed === 'object') {
            notif.unsubscribed = u.emailUnsubscribed;
          }
          return { notif };
        }),
        upsert: vi.fn(async () => undefined),
      },
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(),
      // The platform-wide category switches live in one AppConfig row. These
      // tests are about what the person chose, so the platform is switched on
      // for everything; one test below flips it back to prove a switch Tirbeo
      // has off beats anything the person opted into.
      appConfig: {
        findUnique: vi.fn(async () => ({
          value: { productUpdates: true, offersPromos: true, tips: true },
        })),
      },
    },
  };
});

import { prisma } from '@/infrastructure/db/prisma';
import {
  ESSENTIAL_TEMPLATES,
  shouldSuppressEmail,
  processUnsubscribe,
  isInQuietHours,
} from '@/features/email/emailPrefs';
import { frequencyToMs, isCadenceDue, recapChoice } from '@/jobs/jobs';

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

// ─── The recap sweep's own gate ────────────────────────────────────

describe('recapChoice', () => {
  it('needs an explicit yes in one of the two stores', () => {
    expect(recapChoice({}, {}).summaryEnabled).toBe(false);
    expect(recapChoice({ summaryEnabled: true }, {}).summaryEnabled).toBe(true);
    expect(recapChoice({}, { summaryEnabled: true }).summaryEnabled).toBe(true);
    // An "off" anywhere is off, whichever store the other one says yes in.
    expect(recapChoice({ summaryEnabled: true }, { summaryEnabled: false }).summaryEnabled).toBe(false);
  });

  it('takes the cadence the settings screen wrote, not the mirror\'s', () => {
    expect(recapChoice({ summaryFrequency: 'weekly' }, { summaryFrequency: 'monthly' }).summaryFrequency)
      .toBe('monthly');
    expect(recapChoice({}, { summaryFrequency: 'hourly' }).summaryFrequency).toBe('weekly');
  });

  it('holds a recap back while the account is paused', () => {
    // The mailer would drop the send and then answer as if it had gone out, so
    // a sweep that mailed into a pause would move the clock on a letter nobody
    // read. Blocked here, the clock waits and the recap arrives when the pause
    // lapses.
    const paused = { summaryEnabled: true, emailPaused: true, emailPausedUntil: null };
    expect(recapChoice(paused, paused).mailBlocked).toBe(true);

    // A pause with a date still ahead of us is the same hold.
    const timed = { summaryEnabled: true, emailPaused: true, emailPausedUntil: Date.now() + 3600_000 };
    expect(recapChoice(timed, {})).toMatchObject({ mailBlocked: true, summaryEnabled: true });

    // A pause that already lapsed is not a pause.
    expect(recapChoice({ ...timed, emailPausedUntil: Date.now() - 1000 }, {})).toMatchObject({
      mailBlocked: false,
    });

    // And the global toggle / a one-click unsubscribe still block it.
    expect(recapChoice({ summaryEnabled: true, email: false }, {}).mailBlocked).toBe(true);
    expect(recapChoice({ summaryEnabled: true, unsubscribed: { all: true } }, {}).mailBlocked).toBe(true);
    expect(recapChoice({ summaryEnabled: true }, {}).mailBlocked).toBe(false);
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
    expect(await shouldSuppressEmail('user@test.dev', 'security_tip')).toBe(true);
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(true);
  });

  it('suppresses when category email toggle is off', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, forms: true, formsEmail: false },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'security_tip')).toBe(true);
  });

  it('reads the switch the settings screen actually writes', async () => {
    // The notifications page has one row per category, and it saves that
    // category's email toggle. The older per-category master is on no screen and
    // ships off, so a gate that also required it would leave the switch the
    // person used doing nothing. createNotification now reads the same bit,
    // which is what keeps the in-app sender and the mailer agreeing.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, product: false, productEmail: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(false);

    // Switching it off is the whole opt-out.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, product: true, productEmail: false },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(true);
  });

  it('routes campaign mail through the Offers switch, not the Product one', async () => {
    // "Offers and promotions" on the page writes offersEmail, and the "we miss
    // you" letter is the campaign that switch is about. Classified as product
    // mail it answered to a different row entirely, so the one the person
    // moved decided nothing.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, product: true, productEmail: true, offers: true, offersEmail: false },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'reactivation')).toBe(true);

    // The other way round: offers on is the whole opt-in, and product staying
    // off keeps the announcements out without touching the campaign mail.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, product: true, productEmail: false, offers: true, offersEmail: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'reactivation')).toBe(false);
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(true);

    // Pausing everything quietens the campaign too; a code still gets through.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, offersEmail: true, emailPaused: true, emailPausedUntil: null },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'reactivation')).toBe(true);
    expect(await shouldSuppressEmail('user@test.dev', 'login_otp')).toBe(false);
  });

  it('sends when toggles are on', async () => {
    // Every category email toggle this account is asked about has to be
    // switched on explicitly: DEFAULT_PREFS ships them off, because the
    // alternative is a default that reads as consent.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, forms: true, formsEmail: true, tips: true, tipsEmail: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'security_tip')).toBe(false);
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
    // The unsubscribe map is read out of the merged prefs, which
    // loadNotificationPrefs builds from prisma.user.findUnique — so it has to
    // ride on notificationPreferences. Putting it on the separate
    // emailUnsubscribed column only reached the userPreferences mock, which
    // this path never calls, and the flag silently did nothing.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, productEmail: true, unsubscribed: { product: true } },
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
    expect(await shouldSuppressEmail('user@test.dev', 'security_tip')).toBe(true);

    // Legacy fallback: no tips prefs, productEmail off → suppressed
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, productEmail: false },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'security_tip')).toBe(true);

    // tips on → sends
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, tips: true, tipsEmail: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'security_tip')).toBe(false);
  });

  it('suppresses digest emails without their own explicit opt-in (gate lives here, not only in the sweep)', async () => {
    // Digest-family mail (category 'digest': the account recap, notification
    // digests) is gated centrally, from the merged prefs, in ONE place. The
    // sweep's pre-check is only the first line — a caller that forgets it, or
    // a stored 'false' the sweep raced past, still cannot mail.
    // digestEnabled:false ⇒ no digest email, whatever else is on.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, product: true, productEmail: true, digestEnabled: false },
      emailUnsubscribed: null,
    });
    expect(
      await shouldSuppressEmail('user@test.dev', 'notification_digest', 'digest')
    ).toBe(true);
    // A missing digestEnabled is not consent either — the flag defaults off.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, productEmail: true },
      emailUnsubscribed: null,
    });
    expect(
      await shouldSuppressEmail('user@test.dev', 'notification_digest', 'digest')
    ).toBe(true);
    // notification_digest with NO override is a digest too — it no longer
    // answers to the product toggle alone.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, product: true, productEmail: true, digestEnabled: false },
      emailUnsubscribed: null,
    });
    expect(
      await shouldSuppressEmail('user@test.dev', 'notification_digest')
    ).toBe(true);
    // An explicit yes gets it through…
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, digestEnabled: true },
      emailUnsubscribed: null,
    });
    expect(
      await shouldSuppressEmail('user@test.dev', 'notification_digest', 'digest')
    ).toBe(false);
    // …and pausing everything still overrides even that yes.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, digestEnabled: true, emailPaused: true, emailPausedUntil: null },
      emailUnsubscribed: null,
    });
    expect(
      await shouldSuppressEmail('user@test.dev', 'notification_digest', 'digest')
    ).toBe(true);
    // But global email off suppresses the digest as well
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: false, digestEnabled: true },
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
  });it('treats missing category prefs as opt-in (defaults), not as consent', async () => {
    // An account that has never touched its preferences is NOT opted in to
    // category mail. The global toggle defaults on, so only the categories
    // that have to be asked for are held back — shipping them on would mean
    // mailing somebody about a product update they never requested.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: null,
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(true);
    expect(await shouldSuppressEmail('user@test.dev', 'security_tip')).toBe(true);
  });

  it('still sends essential mail to an account with no prefs at all', async () => {
    // The other half of the default: holding category mail back must not turn
    // into holding everything back.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: null,
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'password_reset_link')).toBe(false);
  });

  it('the reported leak account: every category lands where its own switch says', async () => {
    // The dev-log leak was an account with digestEnabled:false getting
    // 'notification_digest' sends. This pins the whole blob's verdict, one
    // assertion per category, so no future template can quietly widen it.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: {
        push: true, tips: true, email: true, forms: true, offers: true, product: false, support: true,
        security: true, tipsPush: false, formsPush: true, tipsEmail: false, formsEmail: true,
        offersPush: true, emailPaused: false, offersEmail: false, productPush: true, supportPush: true,
        productEmail: false, supportEmail: true, digestEnabled: false, summaryEnabled: true,
        digestFrequency: 'daily', emailPausedUntil: null, summaryFrequency: 'weekly',
      },
      emailUnsubscribed: null,
    });
    // The leak: digest mail is NO, so it is suppressed — at the send, not only
    // in whichever sweep remembered to pre-check.
    expect(await shouldSuppressEmail('user@test.dev', 'notification_digest', 'digest')).toBe(true);
    expect(await shouldSuppressEmail('user@test.dev', 'notification_digest')).toBe(true);
    // The recap is a different switch, and this account said yes: it sends.
    expect(await shouldSuppressEmail('user@test.dev', 'weekly_summary', 'digest')).toBe(false);
    // formsEmail:true ⇒ forms mail through the same digest template is allowed;
    // supportEmail:true likewise. These are the legitimate notification_digest
    // sends the earlier pass wired — not the leak.
    expect(await shouldSuppressEmail('user@test.dev', 'notification_digest', 'forms')).toBe(false);
    expect(await shouldSuppressEmail('user@test.dev', 'admin_reply', 'support')).toBe(false);
    // tipsEmail:false, offersEmail:false, productEmail:false ⇒ all held back.
    expect(await shouldSuppressEmail('user@test.dev', 'security_tip')).toBe(true);
    expect(await shouldSuppressEmail('user@test.dev', 'reactivation')).toBe(true);
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(true);
    // Codes and security alerts are compulsory — they answer to none of the above.
    expect(await shouldSuppressEmail('user@test.dev', 'login_otp')).toBe(false);
    expect(await shouldSuppressEmail('user@test.dev', 'delete_account_otp')).toBe(false);
    expect(await shouldSuppressEmail('user@test.dev', 'suspicious_login')).toBe(false);
    expect(await shouldSuppressEmail('user@test.dev', 'magic_link')).toBe(false);
  });

  it('honours the platform-wide category switch, in one direction only', async () => {
    // A category Tirbeo has switched off is off for everyone, whatever the
    // person chose. The reverse — us mailing somebody past their "no" because
    // our own switch is on — is not a thing that should ever happen.
    const appConfig = (prisma as any).appConfig.findUnique as ReturnType<typeof vi.fn>;
    appConfig.mockResolvedValue({ value: { productUpdates: false, offersPromos: false, tips: true } });
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, product: true, productEmail: true, tips: true, tipsEmail: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(true);
    expect(await shouldSuppressEmail('user@test.dev', 'security_tip')).toBe(false);

    // Switching ours back on does not unilaterally put mail in anyone's inbox:
    // their own toggle still decides.
    appConfig.mockResolvedValue({ value: { productUpdates: true, offersPromos: true, tips: true } });
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, product: true, productEmail: false },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(true);
  });

  it('pause-everything stops category mail but never codes or security alerts', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: {
        email: true, product: true, productEmail: true, tips: true, tipsEmail: true,
        emailPaused: true, emailPausedUntil: null,
      },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(true);
    expect(await shouldSuppressEmail('user@test.dev', 'security_tip')).toBe(true);
    expect(await shouldSuppressEmail('user@test.dev', 'login_otp')).toBe(false);
    expect(await shouldSuppressEmail('user@test.dev', 'suspicious_login')).toBe(false);

    // A pause whose date has passed is not a pause — nobody has to run a job to
    // lift it.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: {
        email: true, product: true, productEmail: true,
        emailPaused: true, emailPausedUntil: Date.now() - 1000,
      },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'product_update')).toBe(false);
  });

  it('the account recap follows the person\'s cadence opt-in, not a category switch', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, summaryEnabled: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'weekly_summary', 'digest')).toBe(false);
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: false, summaryEnabled: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'weekly_summary', 'digest')).toBe(true);
    // The opt-in is explicit: a stored false — or no answer at all, which the
    // merged default reads as off — holds the recap back even if some sweep
    // raced ahead and asked for it.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, summaryEnabled: false, digestEnabled: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'weekly_summary', 'digest')).toBe(true);
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'weekly_summary', 'digest')).toBe(true);
    // digestEnabled governs digests, not the recap; summaryEnabled governs the
    // recap, not digests — each recurring mail answers only to its own switch.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, summaryEnabled: true, digestEnabled: false },
      emailUnsubscribed: null,
    });
    expect(await shouldSuppressEmail('user@test.dev', 'weekly_summary', 'digest')).toBe(false);
    expect(await shouldSuppressEmail('user@test.dev', 'notification_digest', 'digest')).toBe(true);
  });

  it('forms mail is gated by formsEmail at the send itself (digest template reuse included)', async () => {
    // The per-notification mail for a forms event reuses the notification_digest
    // template with categoryOverride 'forms' — the gate must ask the forms
    // toggles, and formsEmail:false must stop it right here, without trusting
    // the caller to have pre-checked.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, forms: true, formsEmail: false },
      emailUnsubscribed: null,
    });
    expect(
      await shouldSuppressEmail('user@test.dev', 'notification_digest', 'forms')
    ).toBe(true);
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, forms: false, formsEmail: true },
      emailUnsubscribed: null,
    });
    expect(
      await shouldSuppressEmail('user@test.dev', 'notification_digest', 'forms')
    ).toBe(false);
    // forms mail is not product mail wearing a hat: productEmail off does not
    // stop it, product on does not start it.
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: { email: true, forms: true, formsEmail: true, product: false, productEmail: false },
      emailUnsubscribed: null,
    });
    expect(
      await shouldSuppressEmail('user@test.dev', 'notification_digest', 'forms')
    ).toBe(false);
  });

  it('reads merged prefs straight by userId when the caller knows it', async () => {
    // The address reverse-lookup fails open for identity addresses with no
    // UserEmail row — that is how a paused / toggled-off account still got
    // mailed. With userId the gate reads the account directly. The test fixture
    // makes this address unresolvable once: without a userId the send sails
    // through (the old fail-open), with one it is gated on the real prefs.
    const userEmail = (prisma as any).userEmail.findFirst as ReturnType<typeof vi.fn>;
    userEmail.mockImplementationOnce(async () => null);
    mockFindUnique.mockResolvedValue({
      id: 'u1',
      notificationPreferences: {
        email: true, forms: true, formsEmail: false,
        summaryEnabled: false, digestEnabled: false,
      },
      emailUnsubscribed: null,
    });
    // Same address, no userId, the lookup finds nothing → fail-open (unchanged
    // behaviour for genuinely unknown recipients — pre-signup mail).
    expect(
      await shouldSuppressEmail('someone@tirbeo.com', 'notification_digest', 'forms')
    ).toBe(false);
    // Now with the userId the sender actually holds: the prefs decide.
    expect(
      await shouldSuppressEmail('someone@tirbeo.com', 'notification_digest', 'forms', 'u1')
    ).toBe(true);
    expect(
      await shouldSuppressEmail('someone@tirbeo.com', 'weekly_summary', 'digest', 'u1')
    ).toBe(true);
    // Essential mail is still exempt on the userId path too.
    expect(
      await shouldSuppressEmail('someone@tirbeo.com', 'login_otp', undefined, 'u1')
    ).toBe(false);
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
    const upsert = (prisma as any).userPreferences.upsert as ReturnType<typeof vi.fn>;
    upsert.mockReset();
    upsert.mockResolvedValue(undefined);
  });

  it('ignores attempts to unsubscribe from security (compulsory)', async () => {
    mockFindUnique.mockResolvedValue({
      notificationPreferences: { email: true },
      emailUnsubscribed: { all: true },
    });
    const prefs = await processUnsubscribe('u1', 'security');
    expect(prefs.email).toBe(true);
    // No write executed
    expect((prisma as any).userPreferences.upsert).not.toHaveBeenCalled();
  });

  it('writes category email toggle + unsub flag', async () => {
    mockFindUnique.mockResolvedValue({
      notificationPreferences: { email: true, productEmail: true },
      emailUnsubscribed: {},
    });
    const prefs = await processUnsubscribe('u1', 'product');
    expect(prefs.productEmail).toBe(false);
    expect((prisma as any).userPreferences.upsert).toHaveBeenCalledTimes(1);
  });

  it("'all' disables the global email toggle", async () => {
    mockFindUnique.mockResolvedValue({
      notificationPreferences: { email: true },
      emailUnsubscribed: {},
    });
    const prefs = await processUnsubscribe('u1', 'all');
    expect(prefs.email).toBe(false);
    expect((prisma as any).userPreferences.upsert).toHaveBeenCalledTimes(1);
  });
});
