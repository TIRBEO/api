/**
 * The click-tracking redirect is unauthenticated and its target comes from the
 * query string, so it must only ever land on a host the platform already
 * trusts. Anything else is a link that reads as `api.tirbeo.com` and lands
 * somewhere else — the shape every phishing mail uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const stamps: unknown[] = [];

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: { $executeRaw: vi.fn(async (text: unknown) => { stamps.push(text); return 1; }) },
}));

// Production, so the allow-list is locked to the app domain and localhost is
// not silently trusted the way it is in a test run.
vi.stubEnv('NODE_ENV', 'production');

import { GET } from '@/app/api/e/c/[id]/route';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

async function follow(target: string): Promise<{ status: number; location: string | null }> {
  const res = await GET(
    new NextRequest(`https://api.tirbeo.com/api/e/c/del_1?u=${encodeURIComponent(b64url(target))}`),
    { params: Promise.resolve({ id: 'del_1' }) },
  );
  return { status: res.status, location: res.headers.get('location') };
}

beforeEach(() => stamps.length = 0);

describe('GET /api/e/c/[id]', () => {
  it('follows a link to our own app', async () => {
    const r = await follow('https://myprofile.tirbeo.com/settings/devices');
    expect(r.status).toBe(302);
    expect(r.location).toBe('https://myprofile.tirbeo.com/settings/devices');
  });

  it('refuses an off-site target instead of redirecting to it', async () => {
    const r = await follow('https://tirbeo.com.phish.test/reset');
    expect(r.status).toBe(400);
    expect(r.location).toBeNull();
  });

  it('refuses a scheme that is not a page at all', async () => {
    const r = await follow('javascript:alert(1)');
    expect(r.status).toBe(400);
  });

  it('refuses garbage where a link should be', async () => {
    const r = await follow('not-a-url');
    expect(r.status).toBe(400);
  });

  it('stamps the click either way — the count is not a reward for a valid link', async () => {
    await follow('https://evil.test/');
    expect(stamps).toHaveLength(1);
  });
});
