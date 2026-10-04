import { sanitizeInput } from '@/features/security/security';

/**
 * The WORK section — one shape, three callers.
 *
 * The settings app's "Personal details → Work" sheet and the accounts app's
 * signup wizard ask the same four questions about the same job, and both must
 * land in the same four columns of `"user"."user_profile"`. Two names for one
 * fact is how a profile quietly loses an edit (the signup form called the job
 * title "Role" and put "Occupation" in the work-location column, so a person
 * who answered the signup wizard saw their job title in the wrong box forever).
 *
 * So the wire names here are the ones the settings app already speaks
 * (`apps/myprofile/api/contract.ts` PROFILE_FIELDS: companyRole, companyName,
 * jobPlace, jobStarted), and the column names are the ones the row already
 * has. Signup posts this shape; `/api/profile` and `/api/internal/profile`
 * PATCH it. Nothing else gets to invent a fifth spelling of "job title".
 *
 * Labels and placeholders live in the two clients — `WORK_FIELDS`/`GENDERS` in
 * `apps/accounts/src/lib/profile-fields.ts` and `JOB_FIELDS` in
 * `apps/myprofile/app/settings/personal-details/page.tsx` — where they are
 * byte-identical: no package is shared between the two apps, so the lists
 * are mirrored by hand and checked by the tests in
 * `apps/api/tests/profile-work.test.ts`.
 */

/** Wire key → `"user"."user_profile"` column. Order is the order the forms ask. */
export const WORK_COLUMNS = {
  companyRole: 'jobRole',
  companyName: 'jobCompany',
  jobPlace: 'jobPlace',
  jobStarted: 'jobStarted',
} as const;

export type WorkWireKey = keyof typeof WORK_COLUMNS;
export type WorkColumns = {
  jobRole: string | null;
  jobCompany: string | null;
  jobPlace: string | null;
  jobStarted: string | null;
};

/** Free text runs to 120 characters (the internal profile endpoint's own cap);
    "Started in" is a year or a `YYYY-MM`, so 10. */
const TEXT_LIMIT: Record<WorkWireKey, number> = {
  companyRole: 120,
  companyName: 120,
  jobPlace: 120,
  jobStarted: 10,
};

/**
 * Old callers posted `role` and `occupation` to `/api/auth/signup`. They are
 * still honoured so nobody's payload 400s, but they are read as the fields
 * they meant: `role` was the job title, `occupation` was stored in
 * `job_place` and is therefore read back as the work location.
 */
const LEGACY_ALIASES: Record<WorkWireKey, string[]> = {
  companyRole: ['role'],
  companyName: ['company'],
  jobPlace: ['occupation'],
  jobStarted: ['jobStartedOn'],
};

export type WorkInput = Record<string, unknown>;

/** First non-empty string among `key` and its legacy spellings. */
function pickString(input: WorkInput, key: WorkWireKey): string | undefined {
  const direct = input[key];
  if (typeof direct === 'string' && direct.trim()) return direct;
  for (const alias of LEGACY_ALIASES[key]) {
    const value = input[alias];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/** Trims and XSS-scrubs each work answer, or returns null when it wasn't given. */
export function normalizeWorkFields(input: WorkInput): WorkColumns {
  const out: WorkColumns = { jobRole: null, jobCompany: null, jobPlace: null, jobStarted: null };
  for (const [wire, column] of Object.entries(WORK_COLUMNS) as [WorkWireKey, keyof WorkColumns][]) {
    const raw = pickString(input, wire);
    if (raw === undefined) continue;
    const clean = sanitizeInput(raw.trim(), TEXT_LIMIT[wire]).trim();
    if (clean) out[column] = clean;
  }
  return out;
}

/** True when the person answered none of the four — so a caller can skip the
    write instead of stamping four nulls over a row it has nothing to say about. */
export function hasWorkInput(input: WorkInput): boolean {
  return Object.values(normalizeWorkFields(input)).some((v) => v !== null);
}

/** The four wire keys a client is allowed to send for work. */
export const WORK_WIRE_KEYS = Object.keys(WORK_COLUMNS) as WorkWireKey[];
