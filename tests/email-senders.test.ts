/**
 * Which mailbox each kind of mail leaves from.
 *
 * The reader decides whether to open a message from its sender line, so the
 * mapping is product behaviour, not an implementation detail: a sign-in code,
 * a warning about the account, a support answer and an alert to the team are
 * four different things and must not arrive as four copies of one automated
 * address. These cases drive a real `sendTemplateEmail` to the provider's HTTP
 * call and read the `From:` back out of the request body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  sends: [] as Array<Record<string, any>>,
}));

vi.mock('next/server', () => ({
  after: (task: unknown) => { void (task as () => unknown)(); },
  NextResponse: { json: (b: any) => b },
  NextRequest: class {},
}));

// Every database read the pipeline makes (config, template override, recipient
// identity) answers "nothing stored", so the env defaults and the built-in
// templates are what gets exercised; a written row answers with a plain id.
vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: new Proxy({}, {
    get: () => new Proxy({}, {
      get: (_t, method) => async () =>
        (method === 'create' || method === 'update' || method === 'upsert') ? { id: 'row_1' } : null,
    }),
  }),
}));

vi.mock('@/features/branding/branding', () => ({
  getBranding: async () => ({
    brandName: 'Tirbeo', brandTagline: '', logoUrl: '', emailFromName: 'Tirbeo',
  }),
}));

vi.mock('@/features/email/emailPrefs', () => ({
  shouldSuppressEmail: async () => false,
  ESSENTIAL_TEMPLATES: new Set<string>(),
  isBrainMandatory: () => false,
  buildUnsubscribeUrl: async () => null,
}));

import { sendTemplateEmail, supportSender } from '@/features/email/email';

const ENV_KEYS = [
  'EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_RESEND_DOMAIN', 'ADMIN_FROM_EMAIL',
  'SUPPORT_EMAIL', 'EMAIL_HELLO_FROM', 'EMAIL_CODE_FROM', 'EMAIL_SECURITY_FROM',
  'EMAIL_SUPPORT_FROM', 'EMAIL_ADMIN_FROM',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  mocks.sends.length = 0;
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.EMAIL_PROVIDER = 'resend';
  process.env.RESEND_API_KEY = 'test-key';
  process.env.EMAIL_RESEND_DOMAIN = 'tirbeo.com';
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    mocks.sends.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ id: 'msg_1' }), text: async () => '' };
  }));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

/** The `From:` line as the mail provider will show it. */
async function senderOf(template: string, vars: Record<string, string> = {}): Promise<string> {
  const result = await sendTemplateEmail('someone@example.com', template, { name: 'Ada', ...vars });
  expect(result.success, `${template}: ${result.error}`).toBe(true);
  expect(mocks.sends).toHaveLength(1);
  return mocks.sends[0].from;
}

/** Every placeholder the staff copy of a request carries. */
const REQUEST_VARS = {
  subject: "Can't sign in",
  senderName: 'Ada L',
  contact: 'ada@example.com',
  account: 'ada@tirbeo.com',
  receivedAt: '22 Oct 2026, 14:02',
  device: 'Chrome on macOS',
  origin: '203.0.113.9 · Kathmandu, Nepal',
  refCode: 'a1b2-c3d4-e5f6-7a8b',
  message: 'I cannot sign in since this morning.',
  dashboardUrl: 'https://admin.tirbeo.com',
  replyHref: 'mailto:ada@example.com?subject=Re%3A%20a1b2',
  replyLabel: 'Reply to ada@example.com',
};

describe('the sender line, per kind of mail', () => {
  it('a sign-in code comes from no-reply, named Tirbeo', async () => {
    expect(await senderOf('login_otp', { otp: '123456' })).toBe('Tirbeo <no-reply@tirbeo.com>');
  });

  it('a warning about the account comes from security', async () => {
    expect(await senderOf('suspicious_login', {
      device: 'Chrome on Linux', location: 'Kathmandu, Nepal', ipAddress: '1.2.3.4', loginTime: 'today',
    })).toBe('Tirbeo Security <security@tirbeo.com>');
  });

  it('an alert to the team comes from the same security mailbox a person reads', async () => {
    expect(await senderOf('admin_alert', {
      subject: 'Account holder disputed a sign-in', message: 'The owner said it was not them.',
      details: 'Account: ada@example.com', dashboardUrl: 'https://admin.tirbeo.com', refCode: 'EVT-ABC12345',
    })).toBe('Tirbeo Security <security@tirbeo.com>');
  });

  it('a support answer comes from support and invites a reply', async () => {
    expect(await senderOf('support_reply', {
      subject: 'Login', replyHtml: '<p>Yes.</p>', receivedAt: 'today', refCode: 'REQ-ABC12345',
    })).toBe('Tirbeo Support <support@tirbeo.com>');
    // A reply has to land where a person reads, not on the sending mailbox.
    expect(mocks.sends[0].replyTo).toBeTruthy();
  });

  it('anything else is brand mail from the hello mailbox', async () => {
    expect(await senderOf('product_update', {
      title: 'What changed', message: 'Something changed.', ctaUrl: 'https://tirbeo.com', ctaLabel: 'See it',
    })).toBe('Tirbeo <hello@tirbeo.com>');
  });

  it('a deployment can name its own mailboxes', async () => {
    process.env.EMAIL_SECURITY_FROM = 'alerts@tirbeo.com';
    expect(await senderOf('password_changed', { changedAt: 'today', ipAddress: '1.2.3.4' }))
      .toBe('Tirbeo Security <alerts@tirbeo.com>');
  });

  it('an address on a domain Resend has not verified is refused, not sent', async () => {
    process.env.EMAIL_SECURITY_FROM = 'alerts@tirbeo.app';
    // verifiedSender falls back rather than earning a 403 from the provider.
    expect(await senderOf('password_changed', { changedAt: 'today', ipAddress: '1.2.3.4' }))
      .toBe('Tirbeo Security <noreply@tirbeo.com>');
  });

  /* Staff's queue reads as a list of people, not a list of tickets: the
     account's own address is the sender, and the answer goes to the mailbox it
     actually checks — which for most accounts is a different address. */
  it('the staff copy of a request arrives as the account that wrote it', async () => {
    const result = await sendTemplateEmail('ops@tirbeo.com', 'support_request_admin', REQUEST_VARS, {
      ...supportSender('ada@tirbeo.com', 'Ada L'),
      replyTo: 'ada@example.com',
      skipSuppression: true,
    });
    expect(result.success, result.error).toBe(true);
    expect(mocks.sends[0].from).toBe('Ada L <ada@tirbeo.com>');
    expect(mocks.sends[0].replyTo).toBe('ada@example.com');
  });

  it('and says so in the subject line, in the words the person typed', async () => {
    const result = await sendTemplateEmail('ops@tirbeo.com', 'support_request_admin', REQUEST_VARS, {
      ...supportSender('ada@tirbeo.com', 'Ada L'),
      replyTo: 'ada@example.com',
      skipSuppression: true,
    });
    expect(result.success, result.error).toBe(true);
    // A header is not markup: `&#39;` there is a typo nobody can undo.
    expect(mocks.sends[0].subject).toBe("Support · Can't sign in");
  });

  it('an account signing in from outside falls back to the support mailbox', async () => {
    // supportSender refuses a domain the provider would 403 for, so the send
    // still happens — from the shared mailbox, replying to the person.
    expect(supportSender('ada@gmail.com', 'Ada')).toEqual({});
    const result = await sendTemplateEmail('ops@tirbeo.com', 'support_request_admin', REQUEST_VARS, {
      ...supportSender('ada@gmail.com', 'Ada'),
      replyTo: 'ada@gmail.com',
      skipSuppression: true,
    });
    expect(result.success, result.error).toBe(true);
    expect(mocks.sends[0].from).toBe('Tirbeo Support <support@tirbeo.com>');
    expect(mocks.sends[0].replyTo).toBe('ada@gmail.com');
  });

  it('will not let a display name add a header of its own', async () => {
    const sender = supportSender('ada@tirbeo.com', 'Ada\r\nBcc: everyone@example.com');
    expect(sender.fromName).toBe('AdaBcc: everyone@example.com');
  });
});
