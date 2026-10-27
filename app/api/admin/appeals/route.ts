import { NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { withPermission } from '@/features/auth/permission-guard';

/* Appeals inbox — the other side of POST /api/support/appeal.

   GET  /api/admin/appeals?decision=&q=&limit=&page=
     Lists every appeal on the platform (newest first) with the account and
     the decision it argues with. `decision` narrows to pending|upheld|
     overturned (default: all); `q` matches an exact appeal/account id, an
     account address, or a substring of the note or restriction title.

   PUT  /api/admin/appeals { id, decision: 'upheld' | 'overturned' }
     One answer per appeal. `overturned` lifts the restriction it argues with
     (endsAt now) — reversing the decision is the point of an overturn — and
     when that restriction was an admin enforcement, the account's status goes
     back to active and the reinstatement is mailed, because closing the row and
     leaving the door shut is a decision the person cannot see. Both outcomes
     write an audit event under the appeal's id and notify the account with
     `Ref: <appeal id>` in the message, so the id an operator copies here finds
     the filing, the decision, the status event and the emails on both sides. */

const DECISIONS = new Set(['upheld', 'overturned']);

export const GET = withPermission('appeals.read', async (request) => {
  const sp = request.nextUrl.searchParams;
  const decision = (sp.get('decision') || '').trim();
  const q = (sp.get('q') || '').trim();
  const limit = Math.min(100, Math.max(1, Number(sp.get('limit')) || 50));
  const page = Math.max(1, Number(sp.get('page')) || 1);

  const where: any = {};
  if (decision === 'pending') where.OR = [{ decision: 'pending' }, { decision: null }];
  else if (decision === 'upheld' || decision === 'overturned') where.decision = decision;
  if (q) {
    where.AND = [
      ...(where.AND || []),
      {
        OR: [
          { id: q },
          { userId: q },
          { user: { email: { contains: q, mode: 'insensitive' } } },
          { note: { contains: q, mode: 'insensitive' } },
          { restriction: { title: { contains: q, mode: 'insensitive' } } },
        ],
      },
    ];
  }

  const pendingWhere = { OR: [{ decision: 'pending' }, { decision: null }] };
  const [rows, total, pending] = await Promise.all([
    prisma.userAppeal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { id: true, email: true, profile: { select: { name: true } } } },
        restriction: {
          select: { id: true, title: true, guideline: true, severity: true, startedAt: true, endsAt: true },
        },
      },
    }),
    prisma.userAppeal.count({ where }),
    prisma.userAppeal.count({ where: pendingWhere }),
  ]);

  return NextResponse.json(
    {
      appeals: rows.map((a: any) => ({
        id: a.id,
        decision: a.decision ?? 'pending',
        note: a.note,
        createdAt: a.createdAt,
        decidedAt: a.decidedAt,
        user: a.user
          ? { id: a.user.id, email: a.user.email, name: a.user.profile?.name ?? null }
          : null,
        restriction: a.restriction
          ? {
              id: a.restriction.id,
              title: a.restriction.title,
              guideline: a.restriction.guideline,
              severity: a.restriction.severity,
              startedAt: a.restriction.startedAt,
              endsAt: a.restriction.endsAt,
            }
          : null,
      })),
      total,
      pending,
      page,
      limit,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
});

export const PUT = withPermission('appeals.manage', async (request, session) => {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const decision = typeof body.decision === 'string' ? body.decision.trim() : '';

  if (!id || !DECISIONS.has(decision)) {
    return NextResponse.json(
      { error: 'id and decision (upheld | overturned) are required.' },
      { status: 400 },
    );
  }

  const appeal = await prisma.userAppeal.findUnique({
    where: { id },
    include: {
      user: { select: { email: true, status: true, profile: { select: { name: true } } } },
      restriction: { select: { id: true, guideline: true, title: true, endsAt: true } },
    },
  });
  if (!appeal) return NextResponse.json({ error: 'Appeal not found.' }, { status: 404 });
  if (appeal.decision && appeal.decision !== 'pending') {
    return NextResponse.json(
      { error: `Already decided (${appeal.decision}) — one answer per appeal.` },
      { status: 409 },
    );
  }

  const decidedAt = new Date();
  let restrictionLifted = false;

  /* The read above answers "has this been decided" for whoever asked first; it
     cannot answer it for two reviewers who ask at the same moment, and a second
     decision on one appeal means the restriction was lifted twice and the
     appellant was mailed twice about the same review. So the write itself is the
     gate: `updateMany` only claims the row while it is still open, and a claim
     that lands on zero rows is somebody else's answer that got here second. */
  let alreadyDecided = false;
  await prisma.$transaction(async (tx: any) => {
    const claimed = await tx.userAppeal.updateMany({
      where: { id, OR: [{ decision: null }, { decision: 'pending' }] },
      data: { decision, decidedAt },
    });
    if (claimed.count !== 1) {
      alreadyDecided = true;
      return;
    }
    // An overturned strike that is still in force stops being in force now;
    // an already-expired one is left honestly expired.
    if (
      decision === 'overturned' &&
      appeal.restriction &&
      (!appeal.restriction.endsAt || appeal.restriction.endsAt > decidedAt)
    ) {
      await tx.userRestriction.update({
        where: { id: appeal.restriction.id },
        data: { endsAt: decidedAt },
      });
      restrictionLifted = true;
    }
  });

  if (alreadyDecided) {
    const current = await prisma.userAppeal.findUnique({ where: { id }, select: { decision: true } });
    return NextResponse.json(
      { error: `Already decided (${current?.decision ?? '—'}) — one answer per appeal.` },
      { status: 409 },
    );
  }

  /* An overturn that closes the restriction but leaves `users.status` banned
     tells the account it is free while the door stays shut — the one answer an
     appeal must never give. So the write the console's own "lift the ban"
     button performs runs here too: status back to active, the reason kept on
     the record, and the reinstatement mailed under the code the account was
     given at the start. Only for an enforcement this platform imposed; a
     restriction an automatic rule filed has no status of its own to undo. */
  const enforcementStatus =
    appeal.user?.status === 'banned' || appeal.user?.status === 'suspended'
      ? appeal.user.status
      : null;
  const reinstated =
    restrictionLifted && appeal.restriction?.guideline === 'admin-enforcement' && !!enforcementStatus;

  let reference: string | null = null;
  if (reinstated && enforcementStatus) {
    const { liftEnforcement, notifyReinstated } = await import('@/features/admin/adminHandlers');
    const answer = `A reviewer went through your appeal and overturned the decision on your account${appeal.restriction?.title ? ` (${appeal.restriction.title})` : ''}. Ref: ${id}`;
    reference = await liftEnforcement({
      userId: appeal.userId,
      fromStatus: enforcementStatus,
      enforcement: enforcementStatus,
      reason: answer,
      liftedAt: decidedAt });
    await notifyReinstated({
      userId: appeal.userId,
      email: appeal.user?.email ?? '',
      name: appeal.user?.profile?.name ?? null,
      kindWord: enforcementStatus === 'banned' ? 'ban' : 'suspension',
      reason: answer,
      refCode: reference,
      liftedAt: decidedAt,
      nextStep: 'You can sign in again now. Nothing on the account was deleted while the decision stood, and the reference above is the same one the first notice carried.' });
  }

  const { createAuditEvent } = await import('@/features/security/audit');
  await createAuditEvent({
    actorId: session.userId,
    action: `appeal.${decision}`,
    title: decision === 'overturned' ? 'Appeal overturned' : 'Appeal upheld',
    targetType: 'appeal',
    targetId: id,
    severity: 'info',
    metadata: {
      appellantId: appeal.userId,
      restrictionId: appeal.restrictionId,
      restrictionLifted,
      ...(reference ? { accountRestored: true, reference } : {}) },
  }).catch(() => {});

  // Security category: compulsory delivery, and the reference id lands in the
  // message body and in the email payload — search either side by this id.
  const { createNotification } = await import('@/features/notifications/notifications');
  await createNotification({
    userId: appeal.userId,
    type: 'security',
    title: reinstated
      ? 'Appeal overturned — your account is open again'
      : restrictionLifted
        ? 'Appeal overturned — restriction lifted'
        : decision === 'overturned'
          ? 'Appeal overturned — decision reversed'
          : 'Appeal reviewed — restriction stands',
    body: reinstated
      ? `A reviewer overturned the decision on your account, the restriction is closed and you can sign in again. Ref: ${id}`
      : restrictionLifted
        ? `A reviewer overturned the decision on your account and the restriction has been lifted. Ref: ${id}`
        : decision === 'overturned'
          ? `A reviewer overturned the decision on your account; the restriction had already expired. Ref: ${id}`
          : `A reviewer went through your appeal and the decision on your account stands. Ref: ${id}`,
    link: '/settings/account-status',
    metadata: { eventId: id, appealId: id, decision },
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    appeal: { id, decision, decidedAt: decidedAt.toISOString() },
    restrictionLifted,
    reference,
  });
});
