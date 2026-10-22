/**
 * The admin alert: one code for one incident, and facts a person can read.
 *
 * Two things made these mails useless before they were worth reading. The
 * first is a reference: an alert that quotes nothing cannot be joined to the
 * row it is about, so the account's own code and the alert's must be the same
 * code — and when no incident exists yet, the code still has to be written
 * down before the mail goes out, or it is a number nobody can look up. The
 * second is the dump: these mails carried raw uuids, ISO timestamps and
 * literal `unknown` strings, which is what a `JSON.stringify` of a row looks
 * like and not what a human on a phone needs.
 *
 * Prisma, the mailer, branding and Redis are stubbed; the fact plate
 * (`email-fragments`) and the reference helpers (`refcode`) are real, because
 * their behaviour is the point.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  activityCreate: vi.fn(async (args: any) => ({ id: 'r1', ...args?.data })),
  sendTemplateEmail: vi.fn(async (..._args: unknown[]) => ({ success: true })),
  userFindUnique: vi.fn(async () => null as any),
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    activityEvent: { create: mocks.activityCreate, findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    user: { findUnique: mocks.userFindUnique },
  },
}));
vi.mock('@/features/email/email', () => ({ sendTemplateEmail: mocks.sendTemplateEmail }));
vi.mock('@/features/auth/redis', () => ({ getRedis: () => null }));
vi.mock('@/features/branding/branding', () => ({
  getBranding: async () => ({ brandName: 'Tirbeo', logoUrl: '', emailFromName: 'Tirbeo' }),
  getApiOrigin: () => 'https://api.tirbeo.com',
}));

import { sendAdminAlert } from '@/features/security/security';

const ROW_ID = '3e22a407-a8f9-4476-b83a-bf438da758f0';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activityCreate.mockImplementation(async (args: any) => ({ id: 'r1', ...args?.data }));
  mocks.userFindUnique.mockResolvedValue(null as any);
});

describe('the reference code', () => {
  it('carries the incident\'s own code into the mail and the log row', async () => {
    await sendAdminAlert('ops@example.com', {
      subject: 'Account holder disputed a sign-in',
      message: 'The owner marked a row as "that wasn\'t me".',
      refCode: 'a1b2-c3d4-e5f6-7a8b',
      details: `Account: ada@example.com`,
    });

    const vars = mocks.sendTemplateEmail.mock.calls[0][2] as Record<string, string>;
    const row = mocks.activityCreate.mock.calls[0][0].data;
    expect(vars.refCode).toBe('a1b2-c3d4-e5f6-7a8b');
    // The same string in both halves of the incident — a mail that quotes a
    // code the log does not carry is a code nobody can find.
    expect(row.metadata.refCode).toBe(vars.refCode);
  });

  it('mints its own code when there is no incident to inherit, and persists it', async () => {
    await sendAdminAlert('ops@example.com', {
      subject: 'Rate limit alert',
      message: 'Blocked a lot of traffic.',
      details: 'Block rate: 30%',
    });

    const vars = mocks.sendTemplateEmail.mock.calls[0][2] as Record<string, string>;
    const row = mocks.activityCreate.mock.calls[0][0].data;
    expect(vars.refCode).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(row.metadata.refCode).toBe(vars.refCode);
  });

  it('leaves no placeholder behind when the caller supplies nothing', async () => {
    await sendAdminAlert('ops@example.com', { subject: 's', message: 'm', details: 'k: v' });
    const vars = mocks.sendTemplateEmail.mock.calls[0][2] as Record<string, string>;
    expect(Object.values(vars).some((v) => /\{\{|Not available/.test(String(v)))).toBe(false);
  });
});

describe('the facts an admin reads', () => {
  it('names the account behind a uuid instead of printing it', async () => {
    mocks.userFindUnique.mockResolvedValue({ profile: { name: 'Ada Lovelace' }, emails: [{ address: 'ada@example.com' }] });
    await sendAdminAlert('ops@example.com', {
      subject: 'Ban',
      message: 'An account was banned.',
      details: `byAdmin: ${ROW_ID}`,
    });

    expect(mocks.userFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ROW_ID } }));
    const details = (mocks.sendTemplateEmail.mock.calls[0][2] as Record<string, string>).details;
    expect(details).toContain('Ada Lovelace (ada@example.com)');
    expect(details).not.toContain(ROW_ID);
    expect(details).toContain('By Admin');
  });

  it('falls back to a quotable row code when the uuid is not an account', async () => {
    await sendAdminAlert('ops@example.com', {
      subject: 'Disputed row',
      message: 'A row was disputed.',
      details: `Row: ${ROW_ID}`,
    });
    const details = (mocks.sendTemplateEmail.mock.calls[0][2] as Record<string, string>).details;
    // 3e22a407-a8f9-4476-… is the code the panel itself shows for that row.
    expect(details).toContain('3e22-a407-a8f9-4476');
    expect(details).not.toContain(ROW_ID);
  });

  it('reads a date as a date, and drops values that are not values', async () => {
    await sendAdminAlert('ops@example.com', {
      subject: 'Sign-in',
      message: 'A sign-in was denied.',
      details: [
        'When: 2026-10-22T08:55:15.120Z',
        'Device: unknown',
        'Address: unknown',
        'Two factor: false',
        'Owner said: "that wasn\'t me"',
      ].join('\n'),
    });
    const details = (mocks.sendTemplateEmail.mock.calls[0][2] as Record<string, string>).details;
    expect(details).toContain('Oct 22, 2026');
    expect(details).not.toContain('2026-10-22T08:55');
    expect(details).not.toContain('unknown');
    expect(details).toContain('no');
    // A line with nothing to say loses the line, not the mail.
    expect(details).not.toContain('Device');
    expect(details).toContain('Owner said');
  });

  it('keeps a bare sentence as its own row', async () => {
    await sendAdminAlert('ops@example.com', { subject: 's', message: 'm', details: 'The worker died twice.' });
    const details = (mocks.sendTemplateEmail.mock.calls[0][2] as Record<string, string>).details;
    expect(details).toContain('The worker died twice.');
    expect(details).toContain('Detail');
  });
});
