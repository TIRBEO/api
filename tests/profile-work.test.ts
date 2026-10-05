/**
 * Unit tests for the WORK section and the recovery-email option — the two
 * shapes the accounts signup wizard and the settings app must agree on.
 *
 * Nothing here touches Prisma, Redis or the network: `normalizeWorkFields`,
 * `recoveryOption` and `maskEmail` are pure, and the cross-app checks read the
 * two client source files as text.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `features/security/security.ts` (via profile-work) imports the pool, and
// the recovery lookup imports it too. Stubbed so this file never opens a
// socket: the functions under test are pure apart from that one query.
const db = vi.hoisted(() => ({
  userEmailFindFirst: vi.fn(async (_args?: unknown) => null as unknown),
}));
vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: { userEmail: { findFirst: db.userEmailFindFirst } },
}));

import {
  normalizeWorkFields,
  hasWorkInput,
  WORK_COLUMNS,
  WORK_WIRE_KEYS,
} from '@/features/auth/profile-work';
import { maskEmail, recoveryOption, verifiedRecoveryAddress } from '@/features/auth/recovery-email';

// The accounts app's copy of the same four questions, imported for real:
// `apps/accounts/src/lib/profile-fields.ts` has no framework dependencies.
import { WORK_FIELDS, WORK_KEYS, GENDERS } from '../../accounts/src/lib/profile-fields';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..'); // apps/api/tests -> repo root

const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('normalizeWorkFields — the one work shape', () => {
  it('maps the settings app\'s wire names onto the row\'s columns', () => {
    expect(
      normalizeWorkFields({
        companyRole: 'Product engineer',
        companyName: 'Tirbeo',
        jobPlace: 'Kathmandu, Nepal',
        jobStarted: '2022',
      }),
    ).toEqual({
      jobRole: 'Product engineer',
      jobCompany: 'Tirbeo',
      jobPlace: 'Kathmandu, Nepal',
      jobStarted: '2022',
    });
  });

  it('honours the names the old signup form posted', () => {
    // `role` was always the job title, and `occupation` was written to
    // job_place — so it is read back as the work location, not as a fifth field.
    expect(
      normalizeWorkFields({ role: 'Nurse', company: 'Health Post', occupation: 'Dolakha' }),
    ).toEqual({ jobRole: 'Nurse', jobCompany: 'Health Post', jobPlace: 'Dolakha', jobStarted: null });
  });

  it('prefers the canonical key when both spellings arrive', () => {
    expect(normalizeWorkFields({ companyRole: 'Engineer', role: 'Legacy' }).jobRole).toBe('Engineer');
  });

  it('trims, drops blanks and never invents an empty string', () => {
    expect(normalizeWorkFields({ companyRole: '   ', companyName: '', jobPlace: '  Biratnagar ' })).toEqual({
      jobRole: null,
      jobCompany: null,
      jobPlace: 'Biratnagar',
      jobStarted: null,
    });
    expect(normalizeWorkFields({})).toEqual({ jobRole: null, jobCompany: null, jobPlace: null, jobStarted: null });
    expect(normalizeWorkFields({ companyRole: 42 as unknown as string })).toEqual({
      jobRole: null,
      jobCompany: null,
      jobPlace: null,
      jobStarted: null,
    });
  });

  it('strips control characters', () => {
    expect(normalizeWorkFields({ companyRole: 'Eng\u0000ineer\u0007' }).jobRole).toBe('Engineer');
  });

  it('holds the same length caps the signup schema declares', () => {
    const long = 'x'.repeat(300);
    const capped = normalizeWorkFields({ companyRole: long, companyName: long, jobPlace: long, jobStarted: long });
    expect(capped.jobRole).toHaveLength(120);
    expect(capped.jobCompany).toHaveLength(120);
    expect(capped.jobPlace).toHaveLength(120);
    expect(capped.jobStarted).toHaveLength(10);
    expect(WORK_KEYS.map((k) => WORK_FIELDS[k].maxLength)).toEqual([120, 120, 120, 10]);
  });

  it('says when nobody answered any of the four', () => {
    expect(hasWorkInput({})).toBe(false);
    expect(hasWorkInput({ companyName: '  ' })).toBe(false);
    expect(hasWorkInput({ companyName: 'Tirbeo' })).toBe(true);
  });

  it('exposes exactly the four wire names the settings app writes', () => {
    expect([...WORK_WIRE_KEYS].sort()).toEqual(['companyName', 'jobPlace', 'jobStarted', 'companyRole'].sort());
    expect(Object.values(WORK_COLUMNS).sort()).toEqual(['jobCompany', 'jobPlace', 'jobRole', 'jobStarted']);
  });
});

describe('maskEmail — the house masking', () => {
  it('keeps two characters of the local part and stars the rest', () => {
    expect(maskEmail('joe.bloggs@example.com')).toBe('jo********@example.com');
    expect(maskEmail('a@x.com')).toBe('a*@x.com');
    expect(maskEmail('ab@x.com')).toBe('ab*@x.com');
  });

  it('leaves an address with no domain alone rather than mangling it', () => {
    expect(maskEmail('not-an-email')).toBe('not-an-email');
  });
});

describe('recoveryOption — what the forgot-password screen may offer', () => {
  const primary = 'jane@example.com';

  it('offers a verified recovery address, masked', () => {
    expect(
      recoveryOption([{ address: 'jane.doe@mail.np', kind: 'recovery', verifiedAt: new Date() }], primary),
    ).toEqual({ hasRecoveryEmail: true, recoveryEmail: 'ja******@mail.np' });
  });

  it('does not offer one nobody proved they receive', () => {
    expect(recoveryOption([{ address: 'typo@mail.np', kind: 'recovery', verifiedAt: null }], primary)).toEqual({
      hasRecoveryEmail: false,
      recoveryEmail: null,
    });
  });

  it('does not offer the login address again, even under another kind', () => {
    expect(
      recoveryOption([{ address: 'JANE@example.com', kind: 'recovery', verifiedAt: new Date() }], primary),
    ).toEqual({ hasRecoveryEmail: false, recoveryEmail: null });
  });

  it('does not offer anything when there is no second address at all', () => {
    expect(recoveryOption([{ address: primary, kind: 'primary', verifiedAt: new Date() }], primary)).toEqual({
      hasRecoveryEmail: false,
      recoveryEmail: null,
    });
    expect(recoveryOption([], primary)).toEqual({ hasRecoveryEmail: false, recoveryEmail: null });
  });

  it('counts a verified secondary the same as a recovery row', () => {
    expect(recoveryOption([{ address: 'alt@mail.np', kind: 'secondary', verifiedAt: new Date() }], primary).hasRecoveryEmail).toBe(true);
  });

  it('ignores unverified rows when a verified one exists', () => {
    const rows = [
      { address: 'first@mail.np', kind: 'recovery', verifiedAt: null },
      { address: 'second@mail.np', kind: 'recovery', verifiedAt: new Date() },
    ];
    expect(recoveryOption(rows, primary)).toEqual({ hasRecoveryEmail: true, recoveryEmail: 'se****@mail.np' });
  });
});

describe('verifiedRecoveryAddress — the mailbox a reset may be posted to', () => {
  it('asks for a verified recovery or secondary row only', async () => {
    db.userEmailFindFirst.mockResolvedValueOnce({ address: 'alt@mail.np' });
    expect(await verifiedRecoveryAddress('u1')).toBe('alt@mail.np');
    const args = db.userEmailFindFirst.mock.calls.at(-1)![0] as any;
    expect(args.where.kind.in).toEqual(['recovery', 'secondary']);
    expect(args.where.verifiedAt).toEqual({ not: null });
    expect(args.where.userId).toBe('u1');
  });

  it('returns null when the only recovery address is unverified', async () => {
    db.userEmailFindFirst.mockResolvedValueOnce(null);
    expect(await verifiedRecoveryAddress('u1')).toBeNull();
  });
});

describe('the two clients ask the WORK questions in the same words', () => {
  /** `apps/myprofile` renders its own labels; there is no shared package, so
      the lists are mirrored by hand and checked here rather than in review. */
  function jobFieldsFromMyprofile() {
    const src = read('apps/myprofile/app/settings/personal-details/page.tsx');
    const block = /const JOB_FIELDS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
    expect(block, 'JOB_FIELDS not found in the settings app').not.toBeNull();
    return [...block![1].matchAll(/label:\s*"([^"]*)",\s*placeholder:\s*"([^"]*)"/g)].map((m) => ({
      label: m[1],
      placeholder: m[2],
    }));
  }

  function gendersFromMyprofile() {
    const src = read('apps/myprofile/app/settings/edit-profile/page.tsx');
    const match = /const GENDERS\s*=\s*\[([^\]]*)\]/.exec(src);
    expect(match, 'GENDERS not found in the settings app').not.toBeNull();
    return [...match![1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  }

  function contractWireNames() {
    const src = read('apps/myprofile/bridge/contract.ts');
    return [...src.matchAll(/local:\s*"(jobRole|jobCompany|jobPlace|jobStartedOn)",\s*wire:\s*"([^"]+)"/g)].map(
      (m) => [m[1], m[2]] as const,
    );
  }

  it('labels and placeholders match, in the same order', () => {
    expect(jobFieldsFromMyprofile()).toEqual(
      WORK_KEYS.map((k) => ({ label: WORK_FIELDS[k].label, placeholder: WORK_FIELDS[k].placeholder })),
    );
  });

  it('the gender options match, in the same order', () => {
    expect(gendersFromMyprofile()).toEqual(GENDERS);
  });

  it('the wire names are the ones the profile endpoint already maps', () => {
    expect(Object.fromEntries(contractWireNames())).toEqual({
      jobRole: 'companyRole',
      jobCompany: 'companyName',
      jobPlace: 'jobPlace',
      jobStartedOn: 'jobStarted',
    });
    // …and the accounts app sends exactly those names to /api/auth/signup,
    // which the brain then writes to exactly those columns.
    const COLUMN_BY_LOCAL: Record<string, string> = {
      jobRole: 'jobRole',
      jobCompany: 'jobCompany',
      jobPlace: 'jobPlace',
      jobStartedOn: 'jobStarted',
    };
    for (const k of WORK_KEYS) {
      const wire = WORK_FIELDS[k].wire;
      expect(WORK_WIRE_KEYS).toContain(wire);
      expect(WORK_COLUMNS[wire as keyof typeof WORK_COLUMNS]).toBe(COLUMN_BY_LOCAL[k]);
    }
  });
});
