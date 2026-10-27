/**
 * Where a finished sign-in is allowed to send the visitor.
 *
 * The bug this pins: a "Log in" click on tirbeo.com handed the accounts app
 * `?redirect_to=https://tirbeo.com/`, and the API honoured it literally — so
 * the visitor ended up back on the marketing page they came from, signed in
 * with nothing to show for it. The marketing root is never a post-sign-in
 * destination; the caller's fallback (the dashboard) is.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/infrastructure/db/prisma', () => ({ prisma: {} }));

const { normalizeOAuthRedirect } = await import('@/features/auth/authHandlers');

describe('post-sign-in redirect targets', () => {
  it('drops the marketing root, with or without query and hash', () => {
    expect(normalizeOAuthRedirect('https://tirbeo.com/')).toBeUndefined();
    expect(normalizeOAuthRedirect('https://tirbeo.com')).toBeUndefined();
    expect(normalizeOAuthRedirect('https://tirbeo.com/?utm=1')).toBeUndefined();
    expect(normalizeOAuthRedirect('https://tirbeo.com/#join')).toBeUndefined();
  });

  it('keeps a real app origin and a deep marketing path', () => {
    expect(normalizeOAuthRedirect('https://myprofile.tirbeo.com/settings'))
      .toBe('https://myprofile.tirbeo.com/settings');
    expect(normalizeOAuthRedirect('https://tirbeo.com/pricing'))
      .toBe('https://tirbeo.com/pricing');
  });

  it('unwraps a handoff screen to the target inside it', () => {
    const inner = encodeURIComponent('https://myprofile.tirbeo.com/settings/devices');
    expect(normalizeOAuthRedirect(`https://accounts.tirbeo.com/oauth-complete?redirect_to=${inner}`))
      .toBe('https://myprofile.tirbeo.com/settings/devices');
  });

  it('refuses anything off the allow-list', () => {
    expect(normalizeOAuthRedirect('https://evil.example/')).toBeUndefined();
    expect(normalizeOAuthRedirect(null)).toBeUndefined();
  });

  /* The shapes that try to look like a Tirbeo target without being one. Each of
     these was a live bypass somewhere in the wild: the userinfo trick reads as
     `myprofile.tirbeo.com` to a human and to a naive `startsWith` check while
     `URL.hostname` says otherwise, and the label-appendage cases defeat a match
     that forgets the dot. */
  it('refuses a target that only spells itself as Tirbeo', () => {
    const refused = [
      'https://myprofile.tirbeo.com@evil.example/',
      'https://tirbeo.com@evil.example/settings',
      'https://evil.example/?next=https://myprofile.tirbeo.com',
      'https://evil.example#https://myprofile.tirbeo.com',
      'https://tirbeo.com.evil.example/',
      'https://tirbeo.com.evil.example/myprofile.tirbeo.com',
      'https://evil-tirbeo.com/',
      'https://myprofiletirbeo.com/',
      'https://tirbeo.co/settings',
      'https://tirbeo.comx/',
      'evil.example',
      '//evil.example/',
      '\\\\evil.example\\',
      'javascript:alert(1)//tirbeo.com',
      'data:text/html,https://tirbeo.com',
      'http://myprofile.tirbeo.com/settings',
    ];
    for (const target of refused) {
      expect(normalizeOAuthRedirect(target), target).toBeUndefined();
    }
  });

  it('does not let an evil target ride inside a Tirbeo handoff URL', () => {
    const nested = encodeURIComponent('https://evil.example/steal');
    expect(normalizeOAuthRedirect(`https://accounts.tirbeo.com/oauth-complete?redirect_to=${nested}`))
      .toBeUndefined();
    // Same trick one level down, on a real app origin that is not a handoff
    // screen: the outer URL is the destination, and its query is data.
    expect(normalizeOAuthRedirect(`https://myprofile.tirbeo.com/settings?back=${nested}`))
      .toBe('https://myprofile.tirbeo.com/settings?back=https%3A%2F%2Fevil.example%2Fsteal');
  });

  it('keeps the legitimate spellings, including case and a deep path', () => {
    expect(normalizeOAuthRedirect('https://MYPROFILE.TIRBEO.COM/settings'))
      .toBe('https://MYPROFILE.TIRBEO.COM/settings');
    expect(normalizeOAuthRedirect('https://admin.tirbeo.com/dash/users?tab=staff'))
      .toBe('https://admin.tirbeo.com/dash/users?tab=staff');
  });
});
