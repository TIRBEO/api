/**
 * The avatar field stores a URL that a page under this platform's own origin
 * will load, so the host check is what keeps a profile from dialing a number of
 * the visitor's choosing. These are the shapes that fooled the previous
 * deny-list: an internal literal, a host that merely ends with a trusted
 * label, and a trailing dot.
 */
import { describe, it, expect } from 'vitest';
import { isTrustedImageHost } from '@/config/app-urls';

process.env.COOKIE_DOMAIN = '.tirbeo.com';

describe('isTrustedImageHost', () => {
  it('takes the providers the CSP already loads', () => {
    expect(isTrustedImageHost('lh3.googleusercontent.com')).toBe(true);
    expect(isTrustedImageHost('avatars.githubusercontent.com')).toBe(true);
    expect(isTrustedImageHost('cdn.discordapp.com')).toBe(true);
  });

  it('takes our own subdomains and the mounted object storage', () => {
    expect(isTrustedImageHost('cdn.tirbeo.com')).toBe(true);
    expect(isTrustedImageHost('tirbeo.com')).toBe(true);
    process.env.R2_PUBLIC_URL = 'https://media.tirbeo.net';
    expect(isTrustedImageHost('media.tirbeo.net')).toBe(true);
    delete process.env.R2_PUBLIC_URL;
  });

  it('refuses a host that only ends with a trusted label', () => {
    expect(isTrustedImageHost('lh3.googleusercontent.com.attacker.test')).toBe(false);
    expect(isTrustedImageHost('notcdn.discordapp.com')).toBe(false);
    expect(isTrustedImageHost('evil-tirbeo.com')).toBe(false);
  });

  it('refuses the addresses the old deny-list spelled out one by one', () => {
    // `localhost` is a legitimate image host outside production (a dev bucket),
    // and `isHostAllowed` says so — so the machine addresses are judged here in
    // the only mode where refusing them matters.
    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = 'production';
    try {
      for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254',
        '100.64.0.1', '10.1.2.3', '192.168.1.1', '[::1]', '[::ffff:127.0.0.1]',
        'metadata.google.internal', 'intranet.local']) {
        expect(isTrustedImageHost(host), host).toBe(false);
      }
    } finally {
      delete env.NODE_ENV;
    }
  });

  it('refuses an empty host', () => {
    expect(isTrustedImageHost('')).toBe(false);
  });
});
