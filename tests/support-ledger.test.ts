/**
 * The support thread in the account's own records.
 *
 * A message to staff is a request, not an edit. Two screens depend on that
 * distinction, and both were wrong in the same way: the change log listed the
 * message as if the account had *changed* it — "A Chrome on Linux changed
 * <the message you wrote>" — while the request record, the one page where it
 * belongs, said nothing about it.
 *
 * So: the change filter must exclude `support.*`, and the request ledger must
 * carry the thread, folded to one row per conversation under the reference code
 * both mails quote. A reply whose question fell out of the read window stays
 * visible on its own — an answer nobody can find is worse than a duplicate.
 *
 * Prisma and the session store are stubbed; no DB, Redis or network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: { userId: 'u1', email: 'ada@example.com', sessionId: 's1' } as any,
  getSession: vi.fn(async () => mocks.session),
  activityFindMany: vi.fn(async (_args: any) => [] as any[]),
  activityFindFirst: vi.fn(async (_args: any) => null as any),
  exportFindMany: vi.fn(async (_args: any) => [] as any[]),
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    activityEvent: {
      findMany: mocks.activityFindMany,
      findFirst: mocks.activityFindFirst,
      create: vi.fn(async (args: any) => ({ id: 'a1', ...args?.data })),
      count: vi.fn(async () => 0),
    },
    dataExportRequest: { findMany: mocks.exportFindMany },
    userLogin: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    userPreferences: { findUnique: vi.fn(async () => null) },
    userSession: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock('@/features/auth/http-guards', () => ({ getSession: mocks.getSession }));
vi.mock('@/features/security/security', () => ({
  sanitizeInput: (value: unknown) => value,
  logSecurityEvent: vi.fn(async () => {}),
  notifyAdmins: vi.fn(async () => {}),
}));
vi.mock('@/features/notifications/notifications', () => ({
  createNotification: vi.fn(async () => {}),
  describeDevice: (ua?: string | null) => (ua ? `device<${ua}>` : 'an unrecognized device'),
  deviceDetail: (ua?: string | null) => (ua ? `device<${ua}>` : null),
  getClientIpFromRequest: () => null,
  loadNotificationPrefs: vi.fn(async () => ({})),
  saveNotificationPrefs: vi.fn(async () => {}),
}));
vi.mock('@/features/auth/reauth', () => ({ requireReauth: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/features/auth/recovery-email', () => ({ maskEmail: (e: string) => e }));
vi.mock('@/features/auth/password', () => ({
  hashPassword: vi.fn(async (p: string) => `hashed:${p}`),
  verifyPassword: vi.fn(async () => false),
  hashRecoveryCode: vi.fn((c: string) => `hashed:${c}`),
}));
vi.mock('@/features/auth/otp', () => ({
  generateOtpCode: vi.fn(() => '123456'),
  storeOtp: vi.fn(async () => {}),
  verifyOtpCode: vi.fn(async () => null),
  sendEmailOtp: vi.fn(async () => {}),
}));
vi.mock('@/features/auth/totp', () => ({
  generateSecret: vi.fn(() => 'secret'),
  generateTotpUri: vi.fn(() => 'otpauth://totp/x'),
  verifyTotp: vi.fn(() => false),
  generateRecoveryCodes: vi.fn(() => []),
  normalizeTotpCode: vi.fn((c: unknown) => String(c ?? '')),
}));
vi.mock('@/features/auth/breach', () => ({ checkPasswordBreach: vi.fn(async () => ({ breached: false })) }));
vi.mock('@/features/auth/jwt', () => ({ verifyMergeToken: vi.fn(async () => null) }));
vi.mock('@/features/auth/redis', () => ({ revokeSessionState: vi.fn(async () => {}) }));
vi.mock('@/features/auth/session', () => ({
  bustSessionCache: vi.fn(async () => {}),
  revokeLongLivedSessions: vi.fn(async () => 0),
}));
vi.mock('@/features/auth/second-factor', () => ({ secondFactorBlocker: vi.fn(async () => null) }));
vi.mock('@/features/auth/authHandlers', () => ({
  bustProfileCache: vi.fn(async () => {}),
  getOauthProviderConfig: vi.fn(async () => null),
}));
vi.mock('@/features/identity/tirbeo', () => ({
  readRecoveryContact: vi.fn(async () => null),
  setRecoveryContact: vi.fn(async () => {}),
}));
vi.mock('@/features/captcha/risk', () => ({ checkWindowLimitDB: vi.fn(async () => true) }));
vi.mock('@/features/email/email', () => ({ sendTemplateEmailAfter: vi.fn(async () => ({ success: true })) }));
vi.mock('@/features/security/loginCoords', () => ({
  coordsByLoginAttempt: vi.fn(async () => [] as any[]),
  coordsFromMeta: vi.fn(() => null),
}));
vi.mock('@/features/status/accountLifecycle', () => ({
  issueDeletionCode: vi.fn(async () => 'code'),
  consumeDeletionCode: vi.fn(async () => false),
  scheduleDeletion: vi.fn(async () => {}),
  cancelDeletion: vi.fn(async () => false),
  activeDeletionFor: vi.fn(async () => null),
  OTP_TTL_MINUTES: 15,
}));
vi.mock('@/features/users/exportRequests', () => ({
  completeExportRequest: vi.fn(async () => {}),
  createExportRequest: vi.fn(async () => ({})),
  exportFileName: vi.fn(() => 'export.json'),
  failExportRequest: vi.fn(async () => {}),
  listExportRequests: vi.fn(async () => []),
  loadExportRequest: vi.fn(async () => null),
  parseRequestedExportFormat: vi.fn(() => 'json' as const),
  renderExportArchive: vi.fn(async () => 'data'),
}));

import { userChangeDetailHandler, userChangesHandler, userRequestsHandler } from '@/features/users/userHandlers';
import type { NextRequest } from 'next/server';

function req(path = '/api/test'): NextRequest {
  const url = `http://localhost${path}`;
  return {
    json: async () => ({}),
    headers: new Headers(),
    url,
    nextUrl: { searchParams: new URLSearchParams(new URL(url).search) },
  } as unknown as NextRequest;
}

const REF = 'a1b2-c3d4-e5f6-7a8b';

const question = {
  id: 'q1',
  userId: 'u1',
  kind: 'support.request',
  title: 'Question about an account change',
  detail: 'I did not make the change you are showing me.',
  severity: 'info',
  ipAddress: '203.0.113.9',
  userAgent: 'Mozilla Chrome',
  metadata: { refCode: REF, subject: 'Question about an account change', message: 'I did not make the change you are showing me.' },
  createdAt: new Date('2026-10-22T10:00:00.000Z'),
};

const answer = {
  id: 'r1',
  userId: 'u1',
  kind: 'support.reply',
  title: 'Re: Question about an account change',
  detail: `Answered ${REF} by mail.`,
  severity: 'info',
  ipAddress: null,
  userAgent: null,
  metadata: { refCode: REF, to: 'ada@example.com' },
  createdAt: new Date('2026-10-22T12:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activityFindMany.mockResolvedValue([]);
  mocks.activityFindFirst.mockResolvedValue(null);
  mocks.exportFindMany.mockResolvedValue([]);
});

describe('the change log and a message to staff', () => {
  it('refuses to call a support thread a change to the account', async () => {
    await userChangesHandler(req('/api/user/changes?limit=50'));
    const where = mocks.activityFindMany.mock.calls[0][0].where;
    const excluded = where.NOT.map((clause: any) => JSON.stringify(clause));
    expect(excluded).toContain(JSON.stringify({ kind: { startsWith: 'support.' } }));
  });

  it('reads one support row by its id as missing, not as a change', async () => {
    // The single-change page goes through the same filter, so a link to a
    // thread cannot repaint it as an edit behind the exclusion above.
    const res = await userChangeDetailHandler(req('/api/user/changes/q1'), question.id);
    expect(res.status).toBe(404);
    const where = mocks.activityFindFirst.mock.calls[0][0].where;
    expect(where.NOT.map((c: any) => JSON.stringify(c)))
      .toContain(JSON.stringify({ kind: { startsWith: 'support.' } }));
  });
});

describe('the request record', () => {
  it('lists a message to staff, with the code the account was given', async () => {
    mocks.activityFindMany.mockResolvedValue([question]);
    const res = await userRequestsHandler(req('/api/user/requests?limit=50'));
    const body = await res.json();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({
      kind: 'support.request', ref: REF, status: 'open', answeredAt: null,
      subject: 'Question about an account change',
    });
  });

  it('asks the ledger for the support kinds at all', async () => {
    await userRequestsHandler(req('/api/user/requests'));
    const kinds = mocks.activityFindMany.mock.calls[0][0].where.kind.in;
    expect(kinds).toContain('support.request');
    expect(kinds).toContain('support.reply');
  });

  it('folds a question and its answer into one answered row', async () => {
    mocks.activityFindMany.mockResolvedValue([answer, question]);
    const body = await (await userRequestsHandler(req('/api/user/requests'))).json();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({
      kind: 'support.request', ref: REF, status: 'answered',
      answeredAt: answer.createdAt.toISOString(),
    });
    expect(body.requests[0].answer.detail).toContain(REF);
  });

  it('keeps an answer whose question fell out of the window on screen', async () => {
    mocks.activityFindMany.mockResolvedValue([answer]);
    const body = await (await userRequestsHandler(req('/api/user/requests'))).json();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ kind: 'support.reply', status: 'answered', ref: REF });
  });
});
