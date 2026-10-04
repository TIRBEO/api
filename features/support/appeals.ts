import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { verifyPassword } from '@/features/auth/password';
import { jsonUnauthorized } from '@/shared/response';

/* ═══════════════════════════════════════════════════════════════════
   Appeals — the one action a decision takes

   An appeal is a written explanation attached to ONE restriction: the row
   must point at a real decision (`status.user_appeals.restriction_id` →
   `status.user_restrictions`), so there is nothing to appeal until a
   decision exists. One appeal per decision, until it's answered.

   POST /api/support/appeal is deliberately credential-based as well as
   cookie-based: the proxy exempts it from the blocked-status gate
   precisely so an account that is suspended can still file its appeal
   without a live session. With a session the body is just
   { restrictionId, note }; without one, { email, password, restrictionId,
   note } proves the caller owns the account.

   GET /api/support/tickets/appeals lists the account's appeals with the
   decision each one argues with and whatever the reviewer has decided.
   ═══════════════════════════════════════════════════════════════════ */

const NOTE_MIN = 40;
const NOTE_MAX = 900;

type AppealRow = {
  id: string;
  restrictionId: string;
  note: string;
  decision: string | null;
  createdAt: string;
  decidedAt: string | null;
  restriction: { title: string; guideline: string; severity: string } | null;
};

function shape(a: {
  id: string;
  restrictionId: string;
  note: string;
  decision: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  restriction?: { title: string; guideline: string; severity: string } | null;
}): AppealRow {
  return {
    id: a.id,
    restrictionId: a.restrictionId,
    note: a.note,
    decision: a.decision,
    createdAt: a.createdAt.toISOString(),
    decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
    restriction: a.restriction
      ? { title: a.restriction.title, guideline: a.restriction.guideline, severity: a.restriction.severity }
      : null,
  };
}

/** POST /api/support/appeal { restrictionId, note } — or, with no session,
    { email, password, restrictionId, note }. Files the appeal against the
    caller's own restriction and answers with the row. */
export async function appealFileHandler(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const restrictionId = typeof body.restrictionId === 'string' ? body.restrictionId : '';
    const note = typeof body.note === 'string' ? body.note.trim() : '';

    if (!restrictionId) {
      return NextResponse.json({ error: 'restrictionId is required' }, { status: 400 });
    }
    if (note.length < NOTE_MIN) {
      return NextResponse.json(
        { error: `A review needs at least ${NOTE_MIN} characters of explanation.` },
        { status: 400 },
      );
    }
    if (note.length > NOTE_MAX) {
      return NextResponse.json(
        { error: `Keep it to ${NOTE_MAX} characters — a person has to read it.` },
        { status: 400 },
      );
    }

    // Session first; credentials are the way in when the account itself is
    // blocked and no session survives.
    let userId = (await getSession(request))?.userId;
    if (!userId) {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!email || !password) return jsonUnauthorized('Sign in, or include your email and password.');
      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, passwordHash: true, status: true },
      });
      if (!user || !user.passwordHash) return jsonUnauthorized('Those details do not open this account.');
      const ok = await verifyPassword(user.passwordHash, password).catch(() => false);
      if (!ok) return jsonUnauthorized('Those details do not open this account.');
      userId = user.id;
    }

    // The decision must exist and must be the caller's own.
    const restriction = await prisma.userRestriction.findFirst({
      where: { id: restrictionId, userId },
      select: { id: true },
    });
    if (!restriction) {
      return NextResponse.json(
        { error: "There's no decision on your account to appeal.", code: 'restriction_not_found' },
        { status: 404 },
      );
    }

    const existing = await prisma.userAppeal.findFirst({
      where: { restrictionId, userId },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: 'A review is already filed for this decision.', code: 'appeal_exists' },
        { status: 409 },
      );
    }

    const appeal = await prisma.userAppeal.create({
      data: { restrictionId, userId, note, decision: 'pending' },
    });

    return NextResponse.json({ ok: true, appeal: shape({ ...appeal, restriction: null }) });
  } catch (err: any) {
    console.error('[APPEAL/FILE]', err?.message || err);
    return NextResponse.json({ error: 'Failed to file the appeal' }, { status: 500 });
  }
}

/** GET /api/support/tickets/appeals — every appeal this account has filed,
    newest first, each carrying the decision it argues with. */
export async function appealsListHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const appeals = await prisma.userAppeal.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: 'desc' },
      include: {
        restriction: { select: { title: true, guideline: true, severity: true } },
      },
    });

    return NextResponse.json({ ok: true, appeals: appeals.map(shape) });
  } catch (err: any) {
    console.error('[APPEAL/LIST]', err?.message || err);
    return NextResponse.json({ error: 'Failed to read appeals' }, { status: 500 });
  }
}
