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
});
