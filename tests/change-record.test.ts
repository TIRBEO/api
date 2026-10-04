/**
 * The account's change record: what a row says, and where it says it came from.
 *
 * Three pure pieces and one writer. Prisma is stubbed (the same shape
 * suspicious-login-alert.test.ts gives it), so no DB is touched; geo.ts and
 * audit.ts's titling are exercised for real because their wording is the
 * product — a history page that shows `profile.companyName.updated` or a
 * datacentre's address is not a record anyone can read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const creates = vi.hoisted(() => vi.fn(async (args: any) => ({ id: 'row-1', ...args?.data })));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: { activityEvent: { create: creates, count: vi.fn(async () => 0) } } }));

import { humanTitle } from '@/features/security/audit';
import { cleanCityName, cleanCountryCode, placeFromParts, resolveLoginPlace } from '@/shared/geo';
import { originFromInternalHeaders, originFromRequest, recordChange } from '@/features/activity/recordChange';

/** A Headers-shaped stand-in: only .get(), which is all these modules ask for. */
const headers = (pairs: Record<string, string>) => ({
  get: (name: string) => pairs[name.toLowerCase()] ?? null });

beforeEach(() => creates.mockClear());

describe('humanTitle — the ledger never shows its own keys', () => {
  it('turns a profile key into the field and the verb', () => {
    expect(humanTitle('profile.companyName.updated')).toBe('Company name updated');
    expect(humanTitle('profile.jobStarted.updated')).toBe('Job started updated');
  });

  it('expands the abbreviations a split would mangle', () => {
    expect(humanTitle('auth.2fa.enabled')).toBe('Two-factor enabled');
    expect(humanTitle('security.totp.enrolled')).toBe('Authenticator enrolled');
    expect(humanTitle('account.email_url.updated')).toBe('Email link updated');
  });

  it('keeps a lone namespace so the phrase still has a subject', () => {
    expect(humanTitle('profile.updated')).toBe('Profile updated');
  });

  it('handles an action with no namespace at all', () => {
    expect(humanTitle('account.linked')).toBe('Account linked');
  });

  it('survives a key with nothing in it', () => {
    expect(humanTitle('')).toBe('');
    expect(humanTitle('...')).toBe('...');
  });
});

describe('placeFromParts — a place, or honestly none', () => {
  it('names city and country together', () => {
    expect(placeFromParts('Kathmandu', 'NP')).toBe('Kathmandu, Nepal');
  });

  it('gives one half when the other is missing', () => {
    expect(placeFromParts(null, 'NP')).toBe('Nepal');
    expect(placeFromParts('Kathmandu', null)).toBe('Kathmandu');
    expect(placeFromParts(null, null)).toBeNull();
  });

  it('treats the codes that mean "we do not actually know" as absent', () => {
    expect(cleanCountryCode('XX')).toBeNull();
    expect(cleanCountryCode('T1')).toBeNull();
    expect(cleanCountryCode('')).toBeNull();
    expect(cleanCountryCode(' np ')).toBe('NP');
  });

  it('un-encodes a city the edge URL-encoded, and drops junk', () => {
    expect(cleanCityName('%20Kath%E2%80%99mandu%20')).toBe('Kath’mandu');
    expect(cleanCityName('undefined')).toBeNull();
    expect(cleanCityName('null')).toBeNull();
    expect(cleanCityName('')).toBeNull();
  });

  it('prefers Vercel over Cloudflare, and falls through when Vercel is a placeholder', () => {
    expect(resolveLoginPlace(headers({ 'x-vercel-ip-city': 'Kathmandu', 'cf-ipcountry': 'US' }))).toBe('Kathmandu, United States');
    expect(resolveLoginPlace(headers({ 'x-vercel-ip-country': 'XX', 'cf-ipcountry': 'NP' }))).toBe('Nepal');
    expect(resolveLoginPlace(headers({}))).toBeNull();
  });
});

describe('origin — whose machine a change is blamed on', () => {
  it('reads the browser off the request when this service got it directly', () => {
    const origin = originFromRequest(
      headers({
        'x-forwarded-for': '203.0.113.9, 10.0.0.1',
        'user-agent': 'Mozilla/5.0 (iPhone)',
        'cf-ipcountry': 'NP',
        'x-vercel-ip-latitude': '27.7172',
        'x-vercel-ip-longitude': '85.3240' }),
    );
    expect(origin).toEqual({
      ip: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (iPhone)',
      location: 'Nepal',
      coords: [27.7172, 85.324] });
  });

  it('reads the x-origin set an internal hop carried, not the hop itself', () => {
    const origin = originFromInternalHeaders(
      headers({
        'user-agent': 'node-fetch/1.0',
        'x-forwarded-for': '10.20.30.40',
        'x-origin-ip': '198.51.100.7',
        'x-origin-user-agent': 'Mozilla/5.0 (Macintosh)',
        'x-origin-country': 'in',
        'x-origin-city': 'Pune',
        'x-origin-lat': '18.5133',
        'x-origin-lng': '73.8446' }),
    );
    expect(origin).toEqual({
      ip: '198.51.100.7',
      userAgent: 'Mozilla/5.0 (Macintosh)',
      location: 'Pune, India',
      coords: [18.5133, 73.8446] });
  });

  it('refuses to pin a change somewhere the numbers do not put it', () => {
    // An empty header parses to 0, and (0,0) is in the Atlantic off Ghana.
    expect(originFromRequest(headers({ 'x-vercel-ip-latitude': '', 'x-vercel-ip-longitude': '' })).coords).toBeNull();
    expect(originFromRequest(headers({ 'x-vercel-ip-latitude': '999', 'x-vercel-ip-longitude': '0' })).coords).toBeNull();
    expect(originFromRequest(headers({ 'x-vercel-ip-latitude': 'nope', 'x-vercel-ip-longitude': '1' })).coords).toBeNull();
    // Half a pair is not a point either.
    expect(originFromRequest(headers({ 'x-vercel-ip-latitude': '27.7' })).coords).toBeNull();
  });

  it('says nothing rather than inventing a place for a local request', () => {
    expect(originFromRequest(headers({}))).toEqual({ ip: null, userAgent: null, location: null, coords: null });
    expect(originFromInternalHeaders(headers({ 'x-origin-country': 'XX' })).location).toBeNull();
  });
});

describe('recordChange — one write, every column the page reads', () => {
  const base = { userId: 'u1', kind: 'profile.website.updated', title: 'Website updated' };

  it('stores the machine, the address and the place', async () => {
    await recordChange({
      ...base,
      detail: 'Changed to "tirbeo.com".',
      metadata: { field: 'website', fields: ['Website'] },
      origin: { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (iPhone)', location: 'Kathmandu, Nepal', coords: [27.7172, 85.324] } });
    const data = creates.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: 'u1',
      kind: 'profile.website.updated',
      title: 'Website updated',
      detail: 'Changed to "tirbeo.com".',
      severity: 'info',
      ipAddress: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (iPhone)' });
    // The page reads `fields` for its chips and `location` for the place.
    expect(data.metadata.fields).toEqual(['Website']);
    expect(data.metadata.location).toBe('Kathmandu, Nepal');
    expect(data.metadata.coords).toEqual([27.7172, 85.324]);
  });

  it('leaves the place out instead of storing an empty string', async () => {
    await recordChange({ ...base, origin: { ip: null, userAgent: null, location: null, coords: null } });
    const data = creates.mock.calls[0][0].data;
    expect(data.ipAddress).toBeNull();
    expect(data.userAgent).toBeNull();
    expect('location' in data.metadata).toBe(false);
    expect('coords' in data.metadata).toBe(false);
  });

  it('never turns a failed record into a failed save', async () => {
    creates.mockRejectedValueOnce(new Error('dead'));
    await expect(recordChange(base)).resolves.toBeUndefined();
  });
});
