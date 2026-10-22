/**
 * "Was this you" — the answer, kept on the account.
 *
 * The owner of an account marks a row in their log as theirs or not theirs.
 * The answer has to outlive the device it was given on (it is read back on
 * every device, dated by the server), and "that wasn't me" has to reach two
 * audiences: the owner's own inbox and the admins — a stranger on someone's
 * account is the one thing a human should look at.
 *
 * Prisma, mail, notifications and the session store are stubbed; no DB,
 * Redis or network. The answer store itself is real (it is prisma and
 * nothing else), so the newest-wins fold and the clearing are exercised
 * for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: { userId: 'u1', email: 'ada@example.com', sessionId: 's1' } as any,
  getSession: vi.fn(async () => mocks.session),
  logSecurityEvent: vi.fn(async (_args: any) => {}),
  notifyAdmins: vi.fn(async (_args: any) => {}),
  createNotification: vi.fn(async (_args: any) => {}),
  activityFindMany: vi.fn(async (_args: any) => [] as any[]),
  activityFindFirst: vi.fn(async (_args: any) => null as any),
  activityCreate: vi.fn(async (args: any) => ({ id: 'a1', ...args?.data })),
  loginFindFirst: vi.fn(async (_args: any) => null as any),
  loginFindMany: vi.fn(async (_args: any) => [] as any[]),
}));

// ─── Prisma ─────────────────────────────────────────────────────────
vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    activityEvent: {
      findMany: mocks.activityFindMany,
      findFirst: mocks.activityFindFirst,
      create: mocks.activityCreate,
      count: vi.fn(async () => 0),
    },
    userLogin: {
      findFirst: mocks.loginFindFirst,
      findMany: mocks.loginFindMany,
    },
    userPreferences: { findUnique: vi.fn(async () => null) },
  },
}));

// ─── Session and the two audiences ──────────────────────────────────
vi.mock('@/features/auth/http-guards', () => ({ getSession: mocks.getSession }));
vi.mock('@/features/security/security', () => ({
  sanitizeInput: (value: unknown) => value,
  logSecurityEvent: mocks.logSecurityEvent,
  notifyAdmins: mocks.notifyAdmins,
}));
vi.mock('@/features/notifications/notifications', () => ({
  createNotification: mocks.createNotification,
  describeDevice: (ua?: string | null) => (ua ? `device<${ua}>` : 'an unrecognized device'),
  deviceDetail: (ua?: string | null) => (ua ? `device<${ua}>` : null),
  getClientIpFromRequest: () => null,
  loadNotificationPrefs: vi.fn(async () => ({})),
  saveNotificationPrefs: vi.fn(async () => {}),
}));

// ─── The rest of the users/security feature graphs ───────────────────
// (stubbed so importing the handlers pulls in no store, mailer or network)
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

import { answerIndex, answersAbout, CHANGE_ANSWER_KIND } from '@/features/users/change-answers';
import { changeAnswerHandler } from '@/features/users/userHandlers';
import { loginHistoryHandler } from '@/features/security/securityHandlers';
import type { NextRequest } from 'next/server';

/** A request with just the bits these handlers read. */
function req(body?: unknown, url = 'http://localhost/api/test'): NextRequest {
  return {
    json: async () => body,
    headers: new Headers(),
    url,
    nextUrl: { searchParams: new URLSearchParams(new URL(url).search) },
  } as unknown as NextRequest;
}

const answerRow = (about: string, answer: string | null, at: string) => ({
  metadata: { about, answer },
  createdAt: new Date(at),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activityFindMany.mockResolvedValue([]);
  mocks.activityFindFirst.mockResolvedValue(null);
  mocks.loginFindFirst.mockResolvedValue(null);
  mocks.loginFindMany.mockResolvedValue([]);
});

// ─── The answer store ───────────────────────────────────────────────
describe('the answer store', () => {
  it('keeps the newest answer about a row', async () => {
    mocks.activityFindMany.mockResolvedValue([
      answerRow('row-1', 'not-me', '2026-03-02T10:00:00.000Z'),
      answerRow('row-1', 'recognised', '2026-03-01T10:00:00.000Z'),
    ]);
    const index = await answerIndex('u1');
    expect(index.get('row-1')).toEqual({ answer: 'not-me', at: '2026-03-02T10:00:00.000Z' });
  });

  it('lets a cleared answer hide an older one, without becoming an answer', async () => {
    mocks.activityFindMany.mockResolvedValue([
      answerRow('row-1', null, '2026-03-02T10:00:00.000Z'),
      answerRow('row-1', 'not-me', '2026-03-01T10:00:00.000Z'),
    ]);
    const index = await answerIndex('u1');
    expect(index.has('row-1')).toBe(false);
  });

  it('answers about sign-in rows and change rows in the same ledger', async () => {
    mocks.activityFindMany.mockResolvedValue([
      answerRow('login-9', 'recognised', '2026-03-02T10:00:00.000Z'),
      answerRow('change-3', 'not-me', '2026-03-01T10:00:00.000Z'),
    ]);
    const about = await answersAbout('u1', ['login-9', 'change-3', 'other']);
    expect(about.get('login-9')?.answer).toBe('recognised');
    expect(about.get('change-3')?.answer).toBe('not-me');
    expect(about.has('other')).toBe(false);
  });

  it('asks for nothing when there is nothing to ask about', async () => {
    const about = await answersAbout('u1', []);
    expect(about.size).toBe(0);
    expect(mocks.activityFindMany).not.toHaveBeenCalled();
  });
});

// ─── Answering ──────────────────────────────────────────────────────
describe('POST /api/user/changes/:id/answer', () => {
  it('records an answer about a sign-in row on the account', async () => {
    mocks.loginFindFirst.mockResolvedValue({
      id: 'login-9', ipAddress: '203.0.113.9', userAgent: 'Mozilla Chrome',
      method: 'otp', success: true, createdAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    const res = await changeAnswerHandler(req({ answer: 'recognised' }), 'login-9');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, id: 'login-9', answer: 'recognised' });
    // The sign-in ledger has no review column: the answer lives in the
    // account's own ledger, keyed by the row it is about.
    expect(mocks.logSecurityEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      eventType: CHANGE_ANSWER_KIND,
      details: expect.objectContaining({ about: 'login-9', answer: 'recognised', aboutKind: 'signin' }),
    }));
  });

  it('records an answer about a change row', async () => {
    mocks.activityFindFirst.mockResolvedValue({
      id: 'change-3', kind: 'profile.name.updated', title: 'Name updated',
      detail: null, severity: 'info', ipAddress: null, userAgent: null,
      metadata: {}, createdAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    const res = await changeAnswerHandler(req({ answer: 'recognised' }), 'change-3');
    expect(res.status).toBe(200);
    expect(mocks.logSecurityEvent).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ aboutKind: 'change' }),
    }));
  });

  it('refuses a row that is not in the account\'s own history', async () => {
    const res = await changeAnswerHandler(req({ answer: 'recognised' }), 'someone-else-row');
    expect(res.status).toBe(404);
    expect(mocks.logSecurityEvent).not.toHaveBeenCalled();
  });

  it('refuses an answer that is neither word', async () => {
    const res = await changeAnswerHandler(req({ answer: 'maybe' }), 'row-1');
    expect(res.status).toBe(400);
    expect(mocks.logSecurityEvent).not.toHaveBeenCalled();
  });

  it('tells the admins and the owner when a sign-in was not theirs', async () => {
    mocks.loginFindFirst.mockResolvedValue({
      id: 'login-9', ipAddress: '203.0.113.9', userAgent: 'Mozilla Chrome',
      method: 'otp', success: true, createdAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    const res = await changeAnswerHandler(req({ answer: 'not-me' }), 'login-9');
    expect(res.status).toBe(200);
    // The admins: a stranger on someone's account is worth a human.
    expect(mocks.notifyAdmins).toHaveBeenCalledTimes(1);
    const alert = mocks.notifyAdmins.mock.calls[0][0] as any;
    expect(alert.severity).toBe('warning');
    // The handle travels as the alert's own reference, not as a line of the
    // dump — one code, matching the one already shown to the owner.
    expect(alert.refCode).toBe('login-9');
    expect(alert.details).toContain('203.0.113.9');
    expect(alert.details).not.toContain('Row:');
    // The owner: in their own inbox, as a security answer.
    expect(mocks.createNotification).toHaveBeenCalledTimes(1);
    const note = mocks.createNotification.mock.calls[0][0] as any;
    expect(note.userId).toBe('u1');
    expect(note.type).toBe('security');
    expect(note.link).toBe('/settings/login-activity');
    expect(note.metadata).toMatchObject({ about: 'login-9', kind: 'signin', ip: '203.0.113.9' });
  });

  it('says nothing to the admins when the row was theirs', async () => {
    mocks.activityFindFirst.mockResolvedValue({
      id: 'change-3', kind: 'profile.name.updated', title: 'Name updated',
      detail: null, severity: 'info', ipAddress: null, userAgent: null,
      metadata: {}, createdAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    await changeAnswerHandler(req({ answer: 'recognised' }), 'change-3');
    expect(mocks.notifyAdmins).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('still keeps the answer when telling the team fails', async () => {
    mocks.loginFindFirst.mockResolvedValue({
      id: 'login-9', ipAddress: null, userAgent: null, method: null,
      success: true, createdAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    mocks.notifyAdmins.mockRejectedValueOnce(new Error('mail down'));
    const res = await changeAnswerHandler(req({ answer: 'not-me' }), 'login-9');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, answer: 'not-me' });
  });

  it('needs a session', async () => {
    mocks.getSession.mockResolvedValueOnce(null as any);
    const res = await changeAnswerHandler(req({ answer: 'recognised' }), 'login-9');
    expect(res.status).toBe(401);
  });
});

// ─── Reading the answer back ────────────────────────────────────────
describe('GET /api/security/login-history', () => {
  it('hands each sign-in row the answer the account holds about it', async () => {
    mocks.loginFindMany.mockResolvedValue([
      { id: 'login-9', ipAddress: '203.0.113.9', userAgent: 'Mozilla Chrome', location: 'Kathmandu', success: true, method: 'otp', createdAt: new Date('2026-03-01T10:00:00.000Z') },
      { id: 'login-8', ipAddress: '198.51.100.7', userAgent: 'Safari', location: null, success: false, method: 'password', createdAt: new Date('2026-02-28T10:00:00.000Z') },
    ]);
    mocks.activityFindMany.mockResolvedValue([
      answerRow('login-9', 'not-me', '2026-03-02T10:00:00.000Z'),
    ]);

    const res = await loginHistoryHandler(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const rows = body.logs as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].said).toEqual({ answer: 'not-me', at: '2026-03-02T10:00:00.000Z' });
    // A row nobody answered is shown as unanswered, not as something else.
    expect(rows[1].said).toBeNull();
  });
});
