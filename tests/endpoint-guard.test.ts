import { describe, it, expect, vi } from 'vitest';

// The guard resolves the hostname before deciding, so the test supplies the
// answer instead of asking DNS. `null` models an unresolvable name, which the
// real lookup() reports by throwing.
const state = vi.hoisted(() => ({ answers: null as { address: string }[] | null }));
vi.mock('node:dns/promises', () => ({
  lookup: async (_host: string, opts: { all?: boolean }) => {
    if (state.answers === null) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return opts.all ? state.answers : state.answers[0];
  },
}));

import { isSafeExternalUrl } from '@/infrastructure/push/endpoint-guard';

const PUBLIC = 'https://hooks.example.com/push';
const v4 = (ip: string) => [{ address: ip }];

async function verdict(url: string, answers: { address: string }[] | null) {
  state.answers = answers;
  return isSafeExternalUrl(url);
}

describe('push/webhook SSRF guard', () => {
  it('allows a public https endpoint', async () => {
    expect(await verdict(PUBLIC, v4('93.184.216.34'))).toBe(true);
  });

  it.each([
    ['10/8', '10.0.0.5'],
    ['172.16/12', '172.20.3.4'],
    ['192.168/16', '192.168.1.1'],
    ['loopback', '127.0.0.1'],
    ['link-local (cloud metadata)', '169.254.169.254'],
    ['this-network', '0.0.0.0'],
    ['CGNAT', '100.64.0.1'],
    ['multicast', '224.0.0.1'],
  ])('blocks a host that resolves to %s', async (_name, ip) => {
    expect(await verdict('https://push.internal.test/hook', v4(ip))).toBe(false);
  });

  it.each([
    ['just below the 172.16/12 window', '172.15.0.1'],
    ['just below the CGNAT window', '100.63.0.1'],
    ['just below multicast', '223.0.0.1'],
    ['just above the 10/8 window', '11.0.0.1'],
  ])('still allows %s', async (_name, ip) => {
    expect(await verdict('https://push.external.test/hook', v4(ip))).toBe(true);
  });

  it('blocks IPv6 loopback and an IPv4-mapped private address', async () => {
    expect(await verdict('https://v6.internal.test/hook', [{ address: '::1' }])).toBe(false);
    expect(await verdict('https://v6.internal.test/hook', [{ address: '::ffff:10.1.2.3' }])).toBe(false);
  });

  it('blocks when any address of a multi-homed host is private', async () => {
    const answers = [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
    expect(await verdict('https://mixed.test/hook', answers)).toBe(false);
  });

  it('refuses an unresolvable host', async () => {
    expect(await verdict('https://no-such-host.test/hook', null)).toBe(false);
  });

  it('refuses http unless the caller opts in, and refuses non-standard ports', async () => {
    state.answers = v4('93.184.216.34');
    expect(await isSafeExternalUrl('http://hooks.example.com/push')).toBe(false);
    expect(await isSafeExternalUrl('http://hooks.example.com/push', { allowHttp: true })).toBe(true);
    expect(await isSafeExternalUrl('https://hooks.example.com:8443/push')).toBe(false);
  });

  it('refuses credentials and blocked hostnames without needing DNS', async () => {
    state.answers = null; // any path that still asks DNS would throw and fail
    expect(await isSafeExternalUrl('https://u:p@hooks.example.com/push')).toBe(false);
    expect(await isSafeExternalUrl('https://localhost/hook')).toBe(false);
    expect(await isSafeExternalUrl('https://box.internal/hook')).toBe(false);
    expect(await isSafeExternalUrl('https://10.0.0.5/hook')).toBe(false);
    expect(await isSafeExternalUrl('not a url')).toBe(false);
  });
});
