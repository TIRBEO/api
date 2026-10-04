/**
 * Who a security/audit row blames for the change.
 *
 * Every write path wants the same three answers — which machine, which address,
 * which place — and there are three ways a row can get them: the route named an
 * origin itself, the request context has one, or nothing does. This pins the
 * order those win in, because the failure mode is silent and ugly: a history
 * page that blames the datacentre for the person's own edit, or one that
 * invents a city for a job that ran in a cron.
 *
 * Prisma is stubbed; nothing here touches a database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const activityCreates = vi.hoisted(() => vi.fn(async (args: any) => ({ id: 'row-1', ...args?.data })));
const loginCreates = vi.hoisted(() => vi.fn(async (args: any) => ({ id: 'login-1', ...args?.data })));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    activityEvent: { create: activityCreates, count: vi.fn(async () => 0) },
    userLogin: { create: loginCreates },
  },
}));

vi.mock('@/features/users/consent', () => ({ hasConsent: vi.fn(async () => true) }));
vi.mock('@/infrastructure/realtime/ws-deliver', () => ({ sendToUserWs: vi.fn() }));
vi.mock('@/features/auth/redis', () => ({ getRedis: vi.fn(async () => null) }));
vi.mock('@/features/email/email', () => ({ sendTemplateEmail: vi.fn(async () => true) }));
vi.mock('@/features/branding/branding', () => ({
  getBranding: vi.fn(async () => ({ brandName: 'Tirbeo', logoUrl: '', emailFromName: 'Tirbeo' })),
}));

import { createAuditEvent } from '@/features/security/audit';
import { logSecurityEvent, recordLoginHistory } from '@/features/security/security';
import { withRequestOrigin } from '@/infrastructure/observability/requestContext';
import { originFromRequest } from '@/shared/changeOrigin';

const headers = (pairs: Record<string, string>) => ({
  get: (name: string) => pairs[name.toLowerCase()] ?? null,
});

const BROWSER = {
  'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1',
  'x-forwarded-for': '203.0.113.9, 10.0.0.1',
  'x-vercel-ip-city': 'Kathmandu',
  'x-vercel-ip-country': 'NP',
  'x-vercel-ip-latitude': '27.7172',
  'x-vercel-ip-longitude': '85.3240',
};

const lastActivity = () => activityCreates.mock.calls[activityCreates.mock.calls.length - 1]?.[0]?.data;

beforeEach(() => {
  activityCreates.mockClear();
  loginCreates.mockClear();
});

describe('createAuditEvent — one origin, whichever door the request came through', () => {
  it('takes the machine and the place off the request context', async () => {
    await withRequestOrigin(headers(BROWSER), () =>
      createAuditEvent({ actorId: 'u1', action: 'passkey.registered' }),
    );
    const data = lastActivity();
    expect(data.ipAddress).toBe('203.0.113.9');
    expect(data.userAgent).toContain('iPhone');
    expect(data.metadata.location).toBe('Kathmandu, Nepal');
    expect(data.metadata.coords).toEqual([27.7172, 85.324]);
  });

  it('lets a route that names its own request win over the context', async () => {
    const other = headers({ 'x-forwarded-for': '198.51.100.7', 'user-agent': 'Other/1.0' });
    await withRequestOrigin(headers(BROWSER), () =>
      createAuditEvent({
        actorId: 'u1',
        action: 'backup_codes.regenerated',
        origin: originFromRequest(other),
      }),
    );
    const data = lastActivity();
    expect(data.ipAddress).toBe('198.51.100.7');
    expect(data.userAgent).toBe('Other/1.0');
    expect('location' in data.metadata).toBe(false);
  });

  it('keeps a half-named origin half-named rather than filling it from the request', async () => {
    // A writer that says "this IP" and nothing else knows the rest is unknown;
    // borrowing the browser's city would put a place on a row the writer could
    // not vouch for.
    await withRequestOrigin(headers(BROWSER), () =>
      createAuditEvent({ actorId: 'u1', action: 'admin.setting.changed', ip: '10.1.1.1' }),
    );
    const data = lastActivity();
    expect(data.ipAddress).toBe('10.1.1.1');
    expect(data.userAgent).toBeNull();
    expect('location' in data.metadata).toBe(false);
    expect('coords' in data.metadata).toBe(false);
  });

  it('writes no place for a job that has no request at all', async () => {
    await createAuditEvent({ actorId: 'u1', action: 'data.purged' });
    const data = lastActivity();
    expect(data.ipAddress).toBeNull();
    expect(data.userAgent).toBeNull();
    expect('location' in data.metadata).toBe(false);
  });

  it('leaves a caller-supplied location alone', async () => {
    await createAuditEvent({ actorId: 'u1', action: 'user.blocked', location: 'From the admin panel' });
    expect(lastActivity().metadata.location).toBe('From the admin panel');
  });

  it('records nothing when no actor can be named', async () => {
    await createAuditEvent({ action: 'anonymous.thing' });
    expect(activityCreates).not.toHaveBeenCalled();
  });
});

describe('logSecurityEvent — the same place on a security row', () => {
  it('adds the city the edge saw, without overwriting what the caller passed', async () => {
    await logSecurityEvent({
      request: { headers: headers(BROWSER) } as any,
      userId: 'u1',
      eventType: 'security.password_changed',
      details: { reason: 'user_requested' },
    });
    const data = lastActivity();
    expect(data.metadata.location).toBe('Kathmandu, Nepal');
    expect(data.metadata.coords).toEqual([27.7172, 85.324]);
    expect(data.metadata.reason).toBe('user_requested');
    expect(data.ipAddress).toBe('203.0.113.9');
  });

  it('falls back to the request context when the caller has no request', async () => {
    await withRequestOrigin(headers(BROWSER), () =>
      logSecurityEvent({ userId: 'u1', eventType: 'security.deletion_cancelled' }),
    );
    const data = lastActivity();
    expect(data.metadata.location).toBe('Kathmandu, Nepal');
    expect(data.ipAddress).toBe('203.0.113.9');
  });

  it('says nothing about place when there is nothing to say', async () => {
    await logSecurityEvent({ userId: 'u1', eventType: 'security.anon' });
    const data = lastActivity();
    expect('location' in data.metadata).toBe(false);
    expect('coords' in data.metadata).toBe(false);
  });
});

describe('recordLoginHistory — the sign-in list has a place column, so fill it', () => {
  it('stores the place beside the address', async () => {
    await recordLoginHistory({
      request: { headers: headers(BROWSER) } as any,
      userId: 'u1',
      email: 'a@example.test',
      success: true,
      method: 'password',
    });
    const data = loginCreates.mock.calls[0][0].data;
    expect(data.location).toBe('Kathmandu, Nepal');
    expect(data.ipAddress).toBe('203.0.113.9');
  });

  it('still names the place when only the context knows it', async () => {
    await withRequestOrigin(headers(BROWSER), () =>
      recordLoginHistory({ userId: 'u1', email: 'a@example.test', success: true, method: 'passkey' }),
    );
    const data = loginCreates.mock.calls[0][0].data;
    expect(data.location).toBe('Kathmandu, Nepal');
    expect(data.userAgent).toContain('iPhone');
  });

  it('leaves the place null rather than guessing one from the address', async () => {
    await recordLoginHistory({
      request: { headers: headers({ 'x-forwarded-for': '203.0.113.9' }) } as any,
      userId: 'u1',
      email: 'a@example.test',
      success: false,
      method: 'password',
    });
    expect(loginCreates.mock.calls[0][0].data.location).toBeNull();
  });
});
