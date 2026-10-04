/**
 * Unit tests for the suspicious-login new-sign-in alert gate and the honest
 * location resolver.
 *
 * Prisma, the email sender, notifications and the device registry are all
 * stubbed (mocked the same way reauth.test.ts stubs them) — no DB, Redis or
 * network. geo.ts is NOT mocked: it is pure and its behaviour is the point.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted, mutable stubs ─────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  // Two knobs the tests set; count() dispatches on the event kind it is asked
  // about so one stub answers both the "device seen before?" and "already
  // alerted recently?" probes.
  deviceSeenCount: 0,
  alertCount: 0,
  activityCreate: vi.fn(async () => ({})),
  sendTemplateEmail: vi.fn(async () => ({ success: true })),
  recordDeviceSeen: vi.fn(async () => {}),
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    activityEvent: {
      count: vi.fn(async (args: any) => {
        const kind = args?.where?.kind;
        if (kind === 'device.seen') return mocks.deviceSeenCount;
        if (kind === 'auth.suspicious_login_alert') return mocks.alertCount;
        return 0;
      }),
      create: mocks.activityCreate,
    },
  },
}));

vi.mock('@/features/email/email', () => ({ sendTemplateEmail: mocks.sendTemplateEmail }));
vi.mock('@/features/captcha/risk', () => ({ recordDeviceSeen: mocks.recordDeviceSeen }));
// Real describeDevice lives in a module with Prisma/branding side effects; keep
// the suite hermetic with a faithful-but-trivial stub.
vi.mock('@/features/notifications/notifications', () => ({
  describeDevice: (ua?: string | null) => (ua ? `device<${ua}>` : 'an unknown device'),
}));

import {
  shouldSendSuspiciousLoginAlert,
  sendSuspiciousLoginAlert,
} from '@/features/security/suspiciousLoginAlert';
import { resolveLoginLocation } from '@/shared/geo';

const FP = 'a'.repeat(64); // a well-formed device fingerprint (>= 16 chars)

function headers(map: Record<string, string>) {
  return { get: (k: string) => (k in map ? map[k] : null) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deviceSeenCount = 0;
  mocks.alertCount = 0;
  mocks.activityCreate.mockResolvedValue({} as any);
  mocks.sendTemplateEmail.mockResolvedValue({ success: true } as any);
});

// ─── The gate: device-based, so a moving IP never spams ─────────────
describe('shouldSendSuspiciousLoginAlert', () => {
  it('mails a genuinely first-seen device (no prior device.seen)', async () => {
    mocks.deviceSeenCount = 0;
    await expect(shouldSendSuspiciousLoginAlert({ userId: 'u1', fingerprint: FP })).resolves.toBe(true);
  });

  it('stays silent for a KNOWN device on an unfamiliar IP (the mobile-hourly case)', async () => {
    mocks.deviceSeenCount = 3; // this fingerprint has signed in here before
    await expect(shouldSendSuspiciousLoginAlert({ userId: 'u1', fingerprint: FP })).resolves.toBe(false);
  });

  it('without a fingerprint, uses a cooldown: recent alert -> no mail', async () => {
    mocks.alertCount = 1;
    await expect(shouldSendSuspiciousLoginAlert({ userId: 'u1', fingerprint: '' })).resolves.toBe(false);
  });

  it('without a fingerprint and no recent alert -> mail', async () => {
    mocks.alertCount = 0;
    await expect(shouldSendSuspiciousLoginAlert({ userId: 'u1', fingerprint: undefined })).resolves.toBe(true);
  });

  it('treats a too-short fingerprint as "no device signal" (cooldown path)', async () => {
    // Short fp can't be trusted to identify a device; must NOT be treated as a
    // brand-new device (which would mail on every sign-in).
    mocks.alertCount = 0;
    const q = shouldSendSuspiciousLoginAlert({ userId: 'u1', fingerprint: 'short' });
    await expect(q).resolves.toBe(true);
    // and only the cooldown probe ran, never the device.seen probe:
    const { prisma } = await import('@/infrastructure/db/prisma');
    const calls = (prisma.activityEvent.count as any).mock.calls.map((c: any) => c[0]?.where?.kind);
    expect(calls).toContain('auth.suspicious_login_alert');
    expect(calls).not.toContain('device.seen');
  });
});

// ─── The sender: sends, resolves location, records the device ───────
describe('sendSuspiciousLoginAlert', () => {
  it('sends suspicious_login with honest vars and marks the device known', async () => {
    mocks.deviceSeenCount = 0;
    const sent = await sendSuspiciousLoginAlert({
      userId: 'u1',
      email: 'ada@example.com',
      name: 'Ada',
      ip: '1.2.3.4',
      userAgent: 'Mozilla Chrome',
      fingerprint: FP,
      headers: headers({ 'x-vercel-ip-city': 'Kathmandu', 'x-vercel-ip-country': 'NP' }),
      method: 'otp',
    });
    expect(sent).toBe(true);
    expect(mocks.sendTemplateEmail).toHaveBeenCalledTimes(1);
    const [to, template, vars] = mocks.sendTemplateEmail.mock.calls[0] as unknown as [string, string, Record<string, string>];
    expect(to).toBe('ada@example.com');
    expect(template).toBe('suspicious_login');
    expect(vars).toMatchObject({ name: 'Ada', device: 'device<Mozilla Chrome>', location: 'Kathmandu, Nepal', ipAddress: '1.2.3.4' });
    // device recorded so the next sign-in from it is treated as known
    expect(mocks.recordDeviceSeen).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', fingerprint: FP }));
    // an audit/cooldown row was written
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: 'auth.suspicious_login_alert' }) }));
  });

  it('does NOT mail a known device (and records nothing)', async () => {
    mocks.deviceSeenCount = 5;
    const sent = await sendSuspiciousLoginAlert({
      userId: 'u1', email: 'ada@example.com', fingerprint: FP, headers: headers({}),
    });
    expect(sent).toBe(false);
    expect(mocks.sendTemplateEmail).not.toHaveBeenCalled();
    expect(mocks.recordDeviceSeen).not.toHaveBeenCalled();
  });

  it('no-ops without an email address', async () => {
    const sent = await sendSuspiciousLoginAlert({ userId: 'u1', email: null, fingerprint: FP });
    expect(sent).toBe(false);
    expect(mocks.sendTemplateEmail).not.toHaveBeenCalled();
  });
});

// ─── Honest location: only what the edge actually said ──────────────
describe('resolveLoginLocation', () => {
  it('combines Vercel city + country', () => {
    expect(resolveLoginLocation(headers({ 'x-vercel-ip-city': 'Kathmandu', 'x-vercel-ip-country': 'NP' })))
      .toBe('Kathmandu, Nepal');
  });

  it('decodes a URL-encoded Vercel city', () => {
    expect(resolveLoginLocation(headers({ 'x-vercel-ip-city': 'San%20Francisco', 'x-vercel-ip-country': 'US' })))
      .toBe('San Francisco, United States');
  });

  it('falls back to country-only when the city is absent', () => {
    expect(resolveLoginLocation(headers({ 'cf-ipcountry': 'NP' }))).toBe('Nepal');
  });

  it('treats Cloudflare XX/T1 (unknown/Tor) as Unknown, never a real place', () => {
    expect(resolveLoginLocation(headers({ 'cf-ipcountry': 'XX' }))).toBe('Unknown');
    expect(resolveLoginLocation(headers({ 'cf-ipcountry': 'T1' }))).toBe('Unknown');
  });

  it('is Unknown with no edge geo headers at all (local dev)', () => {
    expect(resolveLoginLocation(headers({}))).toBe('Unknown');
  });
});
