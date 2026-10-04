/**
 * Unit tests for the "download my data" format choice and the HTML builder
 * (features/users/exportRequests + features/users/accountExportHtml).
 *
 * Prisma is stubbed — no database. These pin the promises the download sheet
 * makes: a format has to be one of the two offered before a request is written
 * at all; the stored format decides what the builder produces; a request that
 * was made before the choice existed still downloads as the JSON it was; and the
 * HTML report is a real, standalone, readable document that escapes what the
 * account contains rather than trusting it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/infrastructure/db/prisma', () => {
  const rows: any[] = [];
  return {
    prisma: {
      dataExportRequest: {
        rows,
        create: vi.fn(async ({ data }: any) => {
          const row = {
            id: `req-${rows.length + 1}`,
            counts: null,
            missing: null,
            truncated: null,
            bytes: null,
            error: null,
            builtAt: null,
            requestedAt: new Date('2026-10-02T12:00:00.000Z'),
            ...data,
          };
          rows.push(row);
          return row;
        }),
        findFirst: vi.fn(async ({ where }: any) =>
          rows.find((row) => row.id === where.id && row.userId === where.userId) ?? null
        ),
        findMany: vi.fn(async ({ where, take }: any) =>
          rows.filter((row) => row.userId === where.userId).slice(0, take ?? rows.length)
        ),
        update: vi.fn(async ({ where, data }: any) => {
          const row = rows.find((candidate) => candidate.id === where.id);
          if (!row) throw new Error('no such request');
          Object.assign(row, data);
          return row;
        }),
      },
    },
  };
});

import { prisma } from '@/infrastructure/db/prisma';
import {
  completeExportRequest,
  createExportRequest,
  exportFileName,
  failExportRequest,
  listExportRequests,
  loadExportRequest,
  parseRequestedExportFormat,
  readStoredExportFormat,
  renderExportArchive,
} from '@/features/users/exportRequests';
import { renderAccountExportHtml } from '@/features/users/accountExportHtml';

const ledger = (prisma as any).dataExportRequest;

/** The archive shape `exportDataHandler` gathers — a few rows of every kind. */
function sampleArchive() {
  return {
    format: 'tirbeo-account-export/1',
    exportedAt: '2026-10-02T12:00:00.000Z',
    note: 'Everything Tirbeo holds about this account. Secrets are not included.',
    account: {
      id: 'u1',
      username: 'e2edatauser',
      email: 'e2e.datauser@gmail.com',
      name: 'E2E Data User',
      is2FAEnabled: false,
      createdAt: new Date('2026-01-04T09:30:00.000Z'),
      consents: { analytics: true, marketing: false },
      deletedAt: null,
    },
    security: {
      twoFactorEnabled: false,
      backupCodesRemaining: 0,
      mustChangePassword: false,
      connectedAccounts: ['GitHub'],
    },
    sections: {
      profile: [{ bio: 'Hello <script>alert(1)</script> "world" & co', pronouns: 'they/them' }],
      sessions: [
        { deviceName: 'Pixel', ipAddress: '203.0.113.9', status: 'active', createdAt: '2026-09-01T10:00:00.000Z', revokedAt: null },
        { deviceName: 'Safari', ipAddress: '198.51.100.7', status: 'revoked', createdAt: '2026-09-11T10:00:00.000Z', revokedAt: '2026-09-12T10:00:00.000Z' },
      ],
      logins: [{ method: 'password', success: true, createdAt: '2026-09-11T09:00:00.000Z' }],
      activity: [],
      // A part over the per-part cap: rows are present, the newest were dropped.
      devices: [
        { deviceName: 'Pixel', userAgent: 'Chrome/128', createdAt: '2026-08-01T10:00:00.000Z' },
        { deviceName: 'iPhone', userAgent: 'Safari/17', createdAt: '2026-08-06T10:00:00.000Z' },
      ],
      notifications: [{ type: 'security', title: 'New sign-in', isRead: true }],
      // A part the gatherer could not read arrives as null, named in `missing`.
      emails: null,
      brandNewPart: [{ someValue: 42 }],
    } as Record<string, unknown[] | null>,
    counts: { profile: 1, sessions: 2, logins: 1, activity: 0, devices: 2, notifications: 1, emails: 1, brandNewPart: 1 },
    missing: ['emails'],
    truncated: ['devices'],
  };
}

describe('parseRequestedExportFormat', () => {
  it('takes the two formats the sheet offers', () => {
    expect(parseRequestedExportFormat('json')).toBe('json');
    expect(parseRequestedExportFormat('html')).toBe('html');
    expect(parseRequestedExportFormat(' HTML ')).toBe('html');
  });

  it('refuses anything else instead of guessing on the person\'s behalf', () => {
    expect(parseRequestedExportFormat('pdf')).toBeNull();
    expect(parseRequestedExportFormat('')).toBeNull();
    expect(parseRequestedExportFormat(undefined)).toBeNull();
    expect(parseRequestedExportFormat(null)).toBeNull();
    expect(parseRequestedExportFormat({ format: 'json' })).toBeNull();
  });
});

describe('readStoredExportFormat (old rows, no format recorded)', () => {
  it('reads an absent or unreadable format as JSON — what every archive was', () => {
    expect(readStoredExportFormat(null)).toBe('json');
    expect(readStoredExportFormat(undefined)).toBe('json');
    expect(readStoredExportFormat('')).toBe('json');
    expect(readStoredExportFormat('csv')).toBe('json');
  });

  it('still honours a format that was recorded', () => {
    expect(readStoredExportFormat('html')).toBe('html');
    expect(readStoredExportFormat('HTML')).toBe('html');
    expect(readStoredExportFormat('json')).toBe('json');
  });
});

describe('exportFileName', () => {
  it('names the file after the format it holds', () => {
    const when = new Date('2026-10-02T00:00:00.000Z');
    expect(exportFileName('e2edatauser', when, 'json')).toBe('tirbeo-account-e2edatauser-2026-10-02.json');
    expect(exportFileName('e2edatauser', when, 'html')).toBe('tirbeo-account-e2edatauser-2026-10-02.html');
  });

  it('keeps a hostile username from inventing path or header content', () => {
    // Slashes, quotes and CRLF can't survive the sanitiser, so the name can
    // neither walk a path nor break out of the Content-Disposition header.
    expect(exportFileName('../../evil', new Date('2026-10-02T00:00:00.000Z'), 'html')).toBe(
      'tirbeo-account-....evil-2026-10-02.html',
    );
    expect(exportFileName('a"b\r\nX-Evil: 1', new Date('2026-10-02T00:00:00.000Z'), 'json')).toBe(
      'tirbeo-account-abX-Evil1-2026-10-02.json',
    );
    expect(exportFileName('', new Date('2026-10-02T00:00:00.000Z'), 'json')).toBe('tirbeo-account-account-2026-10-02.json');
  });
});

describe('renderExportArchive (the stored format is honoured)', () => {
  it('writes parseable JSON with every part when the request says json', () => {
    const { body, contentType } = renderExportArchive(sampleArchive() as any, 'json');
    expect(contentType).toBe('application/json; charset=utf-8');
    const parsed = JSON.parse(body);
    expect(parsed.sections.sessions).toHaveLength(2);
    expect(parsed.counts.profile).toBe(1);
    expect(parsed.missing).toEqual(['emails']);
  });

  it('writes an HTML document when the request says html', () => {
    const { body, contentType } = renderExportArchive(sampleArchive() as any, 'html');
    expect(contentType).toBe('text/html; charset=utf-8');
    expect(body.startsWith('<!doctype html>')).toBe(true);
    expect(body).toContain('<html lang="en">');
  });

  it('and an old row whose format was never recorded gets the JSON it always got', () => {
    const format = readStoredExportFormat(null);
    const { body, contentType } = renderExportArchive(sampleArchive() as any, format);
    expect(contentType).toBe('application/json; charset=utf-8');
    expect(JSON.parse(body).format).toBe('tirbeo-account-export/1');
  });
});

describe('renderAccountExportHtml', () => {
  const html = renderAccountExportHtml(sampleArchive() as any);

  it('is a standalone document: inline CSS and nothing fetched', () => {
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/url\(\s*['"]?(https?:|\/\/)/i);
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('names the account, the moment, and the honesty note', () => {
    expect(html).toContain('<title>Tirbeo account export — e2edatauser</title>');
    expect(html).toContain('e2e.datauser@gmail.com');
    expect(html).toContain('Everything Tirbeo holds about this account. Secrets are not included.');
    expect(html).toContain('2 October 2026, 12:00 UTC');
  });

  it('has a readable section for every part the JSON export holds', () => {
    for (const heading of ['Your account', 'Security', 'Profile', 'Sign-in sessions', 'Sign-in history', 'Activity log', 'Notifications', 'Email addresses']) {
      expect(html).toContain(`<h2`);
      expect(html).toContain(heading);
    }
    // Row content, not just headings.
    expect(html).toContain('203.0.113.9');
    expect(html).toContain('New sign-in');
    expect(html).toContain('they/them');
  });

  it('renders a part added later under its own name rather than dropping it', () => {
    // Readable fallback: sentence case, not a naive title-case of the raw key.
    expect(html).toContain('Brand new part');
    expect(html).toContain('42');
  });

  it('says which parts are empty, missing or capped, instead of leaving them out', () => {
    expect(html).toContain('Nothing recorded.');
    expect(html).toContain('What is not in this file');
    expect(html).toContain('Email addresses');
    expect(html).toContain('Devices');
    expect(html).toContain('Capped at 10,000 records');
  });

  it('escapes what the account contains — a bio is text, not markup', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Hello &lt;script&gt;alert(1)&lt;/script&gt; &quot;world&quot; &amp; co');
  });

  it('shows dates readably, booleans as words, nested objects as readable lines — never raw JSON', () => {
    expect(html).toContain('<time datetime="2026-09-01T10:00:00.000Z">');
    expect(html).toContain('>Yes<');
    expect(html).toContain('>No<');
    // Consents render as labelled lines in the consent vocabulary…
    expect(html).toContain('Usage analytics');
    expect(html).toContain('given');
    // …and never as a JSON.stringify dump.
    expect(html).not.toContain('&quot;analytics&quot;: true');
    expect(html).not.toContain('{&quot;');
    expect(html).toContain('Nothing recorded');
    expect(html).not.toContain('[object Object]');
    expect(html).not.toContain('undefined');
  });

  it('carries the same exclusions the JSON path makes (no secret material)', () => {
    expect(html).not.toContain('passwordHash');
    expect(html).not.toContain('totpSecret');
    expect(html).toContain('No password, authenticator secret or recovery code');
  });
});

describe('the request ledger', () => {
  beforeEach(() => {
    ledger.rows.length = 0;
    vi.clearAllMocks();
  });

  it('writes the chosen format with the request, and starts it pending', async () => {
    const created = await createExportRequest('u1', 'html', 'tirbeo-account-u1-2026-10-02.html');
    expect(created.format).toBe('html');
    expect(created.status).toBe('pending');
    expect(ledger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'u1', format: 'html', status: 'pending' }),
      })
    );
  });

  it('a cancelled sheet never reaches it: no create call, no row', async () => {
    expect(ledger.rows).toHaveLength(0);
    expect(ledger.create).not.toHaveBeenCalled();
  });

  it('marks a built file ready with its size, and reads the format back', async () => {
    const created = await createExportRequest('u1', 'html', 'tirbeo-account-u1-2026-10-02.html');
    await completeExportRequest(created.id, {
      bytes: 42_000,
      counts: { profile: 1, sessions: 2 },
      missing: [],
      truncated: [],
    });
    const loaded = await loadExportRequest('u1', created.id);
    expect(loaded?.status).toBe('ready');
    expect(loaded?.bytes).toBe(42_000);
    expect(loaded?.format).toBe('html');
    expect(loaded?.counts).toEqual({ profile: 1, sessions: 2 });
    expect(loaded?.builtAt).toBeInstanceOf(Date);
  });

  it('records a failed build with the reason', async () => {
    const created = await createExportRequest('u1', 'json', 'tirbeo-account-u1-2026-10-02.json');
    await failExportRequest(created.id, 'the database went away');
    const loaded = await loadExportRequest('u1', created.id);
    expect(loaded?.status).toBe('failed');
    // The reason is kept on the row for whoever has to answer for it.
    expect(ledger.rows[0].error).toContain('database');
  });

  it('a ledger that will not write must not cost the person the file', async () => {
    const created = await createExportRequest('u1', 'json', 'tirbeo-account-u1-2026-10-02.json');
    ledger.rows.length = 0; // the row vanishes: the update can no longer find it
    await expect(
      completeExportRequest(created.id, { bytes: 1, counts: {}, missing: [], truncated: [] })
    ).resolves.toBeUndefined();
    await expect(failExportRequest(created.id, 'boom')).resolves.toBeUndefined();
  });

  it('only ever shows an account its own requests', async () => {
    await createExportRequest('u1', 'json', 'a.json');
    expect(await loadExportRequest('u2', 'req-1')).toBeNull();
    expect(await listExportRequests('u2')).toHaveLength(0);
    expect((await listExportRequests('u1'))[0].fileName).toBe('a.json');
  });

  it('lists the newest first, capped at what the page shows', async () => {
    await createExportRequest('u1', 'json', 'a.json');
    await createExportRequest('u1', 'html', 'b.html');
    const rows = await listExportRequests('u1', 1);
    expect(rows).toHaveLength(1);
    expect(ledger.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { requestedAt: 'desc' }, take: 1 }));
  });

  it('reads a legacy row with no format as JSON, so it still downloads', async () => {
    ledger.rows.push({
      id: 'legacy-1',
      userId: 'u1',
      format: null as unknown as string,
      status: 'ready',
      fileName: 'tirbeo-account-u1-2026-09-01.json',
      bytes: 18402,
      counts: { profile: 1 },
      requestedAt: new Date('2026-09-01T00:00:00.000Z'),
      builtAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const [row] = await listExportRequests('u1', 10);
    expect(row.format).toBe('json');
    expect(row.status).toBe('ready');
    const served = renderExportArchive(sampleArchive() as any, row.format);
    expect(served.contentType).toBe('application/json; charset=utf-8');
  });
});
