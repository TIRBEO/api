import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { jsonUnauthorized } from '@/shared/response';
import { loadAccountStatus } from '@/features/status/accountStatus';

/* ═══════════════════════════════════════════════════════════════════
   Account status checks — the five answers behind "am I in trouble?"

   Every section counts ONLY what its label says, straight from the
   status-domain tables. Nothing is inferred from consent records, pending
   email verifications, or unrelated activity rows, and nothing is
   hardcoded: a brand-new account answers zero on every check, and a count
   only rises from a genuine event in one of these tables —

     • Account standing ......... user.status + the admin's status level
     • Sign-ins we stopped ...... security.user_logins (failed attempts
                                  that were never followed by a success)
                                  + security.captcha_blocks still active
     • What's limited now ....... status.user_restrictions, severity
                                  warning/strike, still in force
     • Checks waiting on you .... status.user_restrictions, severity
                                  notice — asking, not holding
     • What stops people
       finding your account ..... status.user_restrictions whose rule is
                                  about discovery/search/visibility

   An appeal is the one action on a decision, and a decision can only be
   appealed once — so a restriction that already has an appeal of the
   user's own stops being appealable here. That's the same rule the
   appeals endpoint enforces; this read just shows it before you tap.
   ═══════════════════════════════════════════════════════════════════ */

export type CheckItem = {
  id: string;
  title: string;
  sub: string;
  guideline: string;
  at: string;
  /** Only real restrictions can be appealed — an appeal row must point at
      one, so an automatic wall that never filed a decision says so. */
  appealable: boolean;
  ask: string;
};

export type CheckSectionId = 'standing' | 'sign-ins' | 'limits' | 'checks' | 'discovery';

export type CheckSection = {
  id: CheckSectionId;
  title: string;
  items: CheckItem[];
};

export type AccountChecks = {
  level: number;
  sections: CheckSection[];
};

const SECTION_TITLES: Record<CheckSectionId, string> = {
  standing: 'Account standing',
  'sign-ins': 'Sign-ins we stopped',
  limits: "What's limited right now",
  checks: 'Checks waiting on you',
  discovery: 'What stops people finding your account',
};

/** A restriction reads as a discovery block when the rule it was judged
    against is about being found — that section owns it, and "What's limited
    right now" doesn't double-count it. */
const DISCOVERY_RULE = /discover|search|visib|findab|suggest|show\s+me/i;

const iso = (d: Date) => d.toISOString();

function describeIp(ip: string | null, location: string | null): string {
  if (location) return location;
  if (ip) return `address ${ip}`;
  return 'an unknown address';
}

export async function buildAccountChecks(userId: string): Promise<AccountChecks> {
  const now = new Date();

  const [status, user, failures, lastSuccess, activeBlocks, restrictions, appeals] = await Promise.all([
    loadAccountStatus(userId),
    prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, updatedAt: true },
    }),
    prisma.userLogin.findMany({
      where: { userId, success: false },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, method: true, ipAddress: true, location: true, createdAt: true },
    }),
    // Failed-before-success semantics: an attempt the person then got past
    // (a later successful sign-in) is not a stopped sign-in — it was a slip.
    // Only failures after the newest success still read as "we stopped it".
    prisma.userLogin.findFirst({
      where: { userId, success: true },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    prisma.captchaBlock.findMany({
      where: { userId, unblockedAt: null },
      orderBy: { blockedAt: 'desc' },
      take: 20,
      select: { id: true, ipAddress: true, reason: true, blockedAt: true },
    }),
    prisma.userRestriction.findMany({
      where: { userId, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      orderBy: { startedAt: 'desc' },
    }),
    prisma.userAppeal.findMany({
      where: { userId },
      select: { restrictionId: true },
    }),
  ]);

  const appealed = new Set(appeals.map((a) => a.restrictionId));

  // ── Account standing: the account's own status, plus the admin's number ──
  const standingItems: CheckItem[] = [];
  const accountStatus = user?.status ?? 'active';
  if (accountStatus === 'restricted' || accountStatus === 'suspended') {
    const event = await prisma.userStatusEvent.findFirst({
      where: { userId, toStatus: accountStatus as any },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, reason: true },
    }).catch(() => null);
    standingItems.push({
      id: `standing-${accountStatus}`,
      title: accountStatus === 'suspended'
        ? 'The account is suspended'
        : 'The account is under restriction',
      sub: event?.reason
        ? `Reason kept on the decision: ${event.reason}.`
        : 'The account itself is not in normal use while this stands.',
      guideline: 'Account status — set by an admin',
      at: iso(event?.createdAt ?? user?.updatedAt ?? now),
      appealable: false,
      ask: '',
    });
  }
  if (status.level > 0) {
    standingItems.push({
      id: 'standing-level',
      title: `Status level ${status.level}`,
      sub: 'A Tirbeo admin has flagged something on this account. The limits and checks below carry the detail.',
      guideline: 'Account status — admin decision',
      at: status.updatedAt ?? iso(user?.updatedAt ?? now),
      appealable: false,
      ask: '',
    });
  }

  // ── Sign-ins we stopped: real blocked/failed attempts only ─────────────
  const signInItems: CheckItem[] = [];
  const gate = lastSuccess?.createdAt ?? null;
  for (const row of failures) {
    if (gate && row.createdAt <= gate) continue;
    signInItems.push({
      id: `login-${row.id}`,
      title: 'A sign-in was stopped',
      sub: `A failed ${row.method} attempt from ${describeIp(row.ipAddress, row.location)} that never got into the account.`,
      guideline: 'Sign-in — failed attempt',
      at: iso(row.createdAt),
      appealable: false,
      ask: '',
    });
  }
  for (const block of activeBlocks) {
    signInItems.push({
      id: `block-${block.id}`,
      title: 'A sign-in was held back',
      sub: `Automated protection stopped a sign-in from ${describeIp(block.ipAddress, null)} (${block.reason}).`,
      guideline: 'Automated protection — blocked attempt',
      at: iso(block.blockedAt),
      appealable: false,
      ask: '',
    });
  }
  signInItems.sort((a, b) => (a.at < b.at ? 1 : -1));

  // ── user_restrictions, split by what each one is actually doing ────────
  const limitItems: CheckItem[] = [];
  const checkItems: CheckItem[] = [];
  const discoveryItems: CheckItem[] = [];
  for (const r of restrictions) {
    const until = r.endsAt ? ` In force until ${iso(r.endsAt)}.` : ' Still in force.';
    const base = {
      id: r.id,
      title: r.title,
      sub: `${r.detail ?? 'A decision about this account.'}${until}`,
      guideline: r.guideline,
      at: iso(r.startedAt),
      appealable: !appealed.has(r.id),
    };
    if (DISCOVERY_RULE.test(`${r.guideline} ${r.title}`)) {
      discoveryItems.push({ ...base, ask: 'Tell us why this is wrong and a person will read it.' });
    } else if (r.severity === 'notice') {
      checkItems.push({ ...base, ask: 'Answer it, or say why it doesn\'t apply, and it closes.' });
    } else {
      limitItems.push({ ...base, ask: 'Tell us why this is wrong and a person will read it.' });
    }
  }

  return {
    level: status.level,
    sections: [
      { id: 'standing', title: SECTION_TITLES.standing, items: standingItems },
      { id: 'sign-ins', title: SECTION_TITLES['sign-ins'], items: signInItems },
      { id: 'limits', title: SECTION_TITLES.limits, items: limitItems },
      { id: 'checks', title: SECTION_TITLES.checks, items: checkItems },
      { id: 'discovery', title: SECTION_TITLES.discovery, items: discoveryItems },
    ],
  };
}

/** GET /api/user/account-checks — the five checks, derived from the status
    tables. A clean account gets five empty sections, never a 404. */
export async function accountChecksHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const checks = await buildAccountChecks(session.userId);
    return NextResponse.json({ ok: true, ...checks });
  } catch (err: any) {
    console.error('[ACCOUNT_CHECKS]', err?.message || err);
    return NextResponse.json({ error: 'Failed to read account checks' }, { status: 500 });
  }
}
