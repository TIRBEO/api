import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/infrastructure/db/prisma';
import { originFromInternalHeaders, recordChange } from '@/features/activity/recordChange';

/**
 * Profile read and write for the profile service (`apps/myprofile`), on the
 * assumption that the caller has already worked out who the user is.
 *
 * The read is one narrow select of the account row plus its profile; the
 * write is one update plus the activity event and notification each change
 * must produce. What is deliberately NOT skipped: those two records — they
 * are what the activity-log and notifications screens show the user.
 *
 * SECURITY — `x-user-id` is a privilege, so it is read only after the service
 * token matches. This route must never be reachable from outside the
 * platform's own network.
 */

const PROFILE_SELECT = {
  id: true,
  username: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  profile: {
    select: {
      name: true, bio: true, gender: true, birthday: true,
      photoUrl: true, bannerUrl: true, pronouns: true, location: true,
      website: true, jobRole: true, jobCompany: true, jobPlace: true,
      jobStarted: true, skills: true, followers: true, following: true,
    },
  },
  emails: { select: { address: true, kind: true, isDefault: true }, where: { kind: 'primary' }, take: 1 },
  phone: { select: { number: true, verifiedAt: true } },
} as const;

/** Flat wire shape the profile service's contract.ts maps from. */
function toWire(u: any): Record<string, unknown> {
  const p = u.profile ?? {};
  return {
    id: u.id,
    username: u.username,
    status: u.status,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    name: p.name ?? null,
    bio: p.bio ?? null,
    gender: p.gender ?? null,
    birthday: p.birthday ?? null,
    photoUrl: p.photoUrl ?? null,
    bannerUrl: p.bannerUrl ?? null,
    pronouns: p.pronouns ?? null,
    location: p.location ?? null,
    website: p.website ?? null,
    companyRole: p.jobRole ?? null,
    companyName: p.jobCompany ?? null,
    jobPlace: p.jobPlace ?? null,
    jobStarted: p.jobStarted ?? null,
    skills: p.skills ?? [],
    followers: p.followers ?? 0,
    following: p.following ?? 0,
    email: u.emails?.[0]?.address ?? null,
    phoneNumber: u.phone?.number ?? null,
  };
}

/**
 * Every rule carries a sentence the person editing can act on.
 *
 * The profile service forwards the fields it could not validate itself (its own
 * rules are looser), so whatever zod says here is shown verbatim under the
 * input — zod's defaults read like a stack trace ("Too big: expected string to
 * have <=40 characters"), which is not something to put in front of a user.
 * The wording matches `apps/myprofile/api/validation.ts` so a field reads the
 * same whether it was caught on the way in or on the row's own terms.
 */
const MUST_BE_TEXT = { error: 'Must be text' } as const;
const UNDER = (n: number) => `Keep it under ${n} characters`;

const patchSchema = z
  .object({
    name: z.string(MUST_BE_TEXT).min(1, 'Needed before you can save').max(60, UNDER(60)).optional(),
    username: z
      .string(MUST_BE_TEXT)
      .regex(/^[a-z0-9._]{2,30}$/, '2-30 characters: lowercase letters, numbers, dot or underscore')
      .optional(),
    bio: z.string(MUST_BE_TEXT).max(2000, UNDER(2000)).nullable().optional(),
    gender: z.string(MUST_BE_TEXT).max(40, UNDER(40)).nullable().optional(),
    birthday: z.string(MUST_BE_TEXT).nullable().optional(),
    photoUrl: z.string(MUST_BE_TEXT).nullable().optional(),
    bannerUrl: z.string(MUST_BE_TEXT).nullable().optional(),
    pronouns: z.string(MUST_BE_TEXT).max(40, UNDER(40)).nullable().optional(),
    location: z.string(MUST_BE_TEXT).max(120, UNDER(120)).nullable().optional(),
    website: z.string(MUST_BE_TEXT).max(300, UNDER(300)).nullable().optional(),
    companyRole: z.string(MUST_BE_TEXT).max(120, UNDER(120)).nullable().optional(),
    companyName: z.string(MUST_BE_TEXT).max(120, UNDER(120)).nullable().optional(),
    jobPlace: z.string(MUST_BE_TEXT).max(120, UNDER(120)).nullable().optional(),
    jobStarted: z.string(MUST_BE_TEXT).max(10, 'Use a date like 2024-01').nullable().optional(),
    skills: z
      .array(z.string(MUST_BE_TEXT).max(60, 'Keep each skill under 60 characters'), {
        error: 'Must be a list of skills',
      })
      .max(8, 'Up to 8 skills')
      .optional(),
  })
  .strict();

/**
 * Field-keyed errors for the response. An unknown key has no `path` of its
 * own, so it is named from the issue instead of collapsing into a blank field;
 * anything else keeps the message the rule above wrote.
 */
function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) fields[key] = 'Not a field you can change here';
      continue;
    }
    /* The form looks its errors up by field name, so a rule that fired on an
       item inside a list (`skills.0`) is reported against `skills` — the input
       that actually has a note under it. */
    const key = issue.path.length > 0 ? String(issue.path[0]) : '';
    if (key) fields[key] = issue.message;
  }
  return fields;
}

function tokenMatches(supplied: string | null, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Returns a NextResponse when the caller is not this service, otherwise null. */
function authorize(request: NextRequest): NextResponse | null {
  const expected = process.env.INTERNAL_API_SECRET || '';
  if (!expected) {
    console.error('[INTERNAL PROFILE] INTERNAL_API_SECRET is not set — endpoint disabled');
    return NextResponse.json({ error: 'The internal profile endpoint is not configured.', code: 'not_configured' }, { status: 501 });
  }
  if (!tokenMatches(request.headers.get('x-internal-token'), expected)) {
    return NextResponse.json({ error: 'Not authorised for internal access.', code: 'forbidden' }, { status: 403 });
  }
  const userId = (request.headers.get('x-user-id') || '').trim();
  if (!userId || userId.length > 64) {
    return NextResponse.json({ error: 'No account identified for this internal call.', code: 'missing_subject' }, { status: 400 });
  }
  return null;
}

export async function internalProfileHandler(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;
  const userId = (request.headers.get('x-user-id') || '').trim();

  try {
    if (request.method === 'GET') {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT });
      if (!user) return NextResponse.json({ error: 'No such account.', code: 'not_found' }, { status: 404 });
      return NextResponse.json(toWire(user), { headers: { 'cache-control': 'no-store' } });
    }

    if (request.method !== 'PATCH' && request.method !== 'PUT') {
      return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({
        error: 'Some fields need attention before this can be saved.',
        code: 'invalid_fields',
        fields: fieldErrors(parsed.error),
      }, { status: 400 });
    }

    const prev = await prisma.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT });
    if (!prev) return NextResponse.json({ error: 'No such account.', code: 'not_found' }, { status: 404 });

    const d = parsed.data;
    const prevWire = toWire(prev);

    // A handle is claimed once — checked before writing, so two clients
    // saving at once get a clean answer instead of a constraint crash.
    if (d.username && d.username !== prevWire.username) {
      const clash = await prisma.user.findFirst({
        where: { username: d.username, id: { not: userId } },
        select: { id: true },
      });
      if (clash) {
        return NextResponse.json(
          { error: 'Some fields need attention before this can be saved.', code: 'invalid_fields', fields: { username: 'That username is taken' } },
          { status: 409 },
        );
      }
    }

    const profileData: Record<string, unknown> = {};
    const FIELD_MAP: Record<string, string> = {
      name: 'name', bio: 'bio', gender: 'gender', photoUrl: 'photoUrl',
      bannerUrl: 'bannerUrl', pronouns: 'pronouns', location: 'location',
      website: 'website', companyRole: 'jobRole', companyName: 'jobCompany',
      jobPlace: 'jobPlace', jobStarted: 'jobStarted',
    };
    for (const [wire, col] of Object.entries(FIELD_MAP)) {
      if (d[wire as keyof typeof d] !== undefined) profileData[col] = d[wire as keyof typeof d];
    }
    if (d.birthday !== undefined) {
      if (!d.birthday) profileData.birthday = null;
      else {
        const dt = new Date(d.birthday);
        profileData.birthday = Number.isNaN(dt.getTime()) ? null : dt;
      }
    }
    if (d.skills !== undefined) profileData.skills = d.skills;

    // Username lives on the account row, everything else on the profile row.
    const userUpdate = d.username !== undefined ? { username: d.username } : {};
    const hasProfileData = Object.keys(profileData).length > 0;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...userUpdate,
        ...(hasProfileData
          ? { profile: { upsert: { create: profileData, update: profileData } } }
          : {}),
      },
      select: PROFILE_SELECT,
    });

    const nowWire = toWire(updated);
    const same = (a: unknown, b: unknown) => {
      if (a instanceof Date || b instanceof Date) {
        return new Date((a ?? 0) as any).getTime() === new Date((b ?? 0) as any).getTime();
      }
      return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    };
    const changed = Object.keys(nowWire).filter(
      (k) => !['id', 'createdAt', 'updatedAt'].includes(k) && !same(prevWire[k], nowWire[k]),
    );

    if (changed.length > 0) {
      /* The profile service runs as its own box, so the headers on this hop
         belong to that box and not to the owner's browser. Their facts arrive
         as the x-origin-* set; without them the record would blame the
         datacentre for every edit. */
      const origin = originFromInternalHeaders(request.headers);
      for (const field of changed) {
        const label = FIELD_LABELS[field] ?? field.replace(/([A-Z])/g, ' $1').trim();
        const raw = nowWire[field];
        const display = raw instanceof Date ? raw.toISOString().split('T')[0] : raw;
        const hasValue = display !== null && display !== undefined && String(display) !== '';

        void recordChange({
          userId,
          kind: `profile.${field}.updated`,
          title: `${label} updated`,
          detail: hasValue ? `Changed to "${String(display).slice(0, 200)}".` : 'Removed.',
          severity: 'info',
          metadata: { field, fields: [label], from: (prevWire[field] ?? null) as any, to: display as any, via: 'profile-service' },
          origin,
        });

        prisma.notification.create({
          data: {
            userId,
            type: 'system',
            title: `${label} updated`,
            body: hasValue
              ? `Your ${label.toLowerCase()} was changed to "${String(display).slice(0, 100)}".`
              : `Your ${label.toLowerCase()} was removed.`,
            link: '/settings/edit-profile',
            metadata: { field, from: (prevWire[field] ?? null) as any, to: display as any } as any,
          },
        }).catch((e) => console.error('[NOTIFICATION]', e?.message));
      }
    }

    return NextResponse.json(nowWire, { headers: { 'cache-control': 'no-store' } });
  } catch (err: any) {
    console.error('[INTERNAL PROFILE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to process request', code: 'internal_error' }, { status: 500 });
  }
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Display name',
  username: 'Username',
  photoUrl: 'Profile photo',
  bannerUrl: 'Banner',
  bio: 'Bio',
  website: 'Website',
  gender: 'Gender',
  birthday: 'Birthday',
  pronouns: 'Pronouns',
  location: 'Location',
  companyRole: 'Job title',
  companyName: 'Company name',
  jobPlace: 'Work location',
  jobStarted: 'Started in',
  skills: 'Skills',
  email: 'Email',
  phoneNumber: 'Phone number',
};
