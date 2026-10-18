import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { withAdmin } from '@/features/auth/role-guard';

/* Appeals inbox — the other side of POST /api/support/appeal.

   GET  /api/admin/appeals?decision=&q=&limit=&page=
     Lists every appeal on the platform (newest first) with the account and
     the decision it argues with. `decision` narrows to pending|upheld|
     overturned (default: all); `q` matches an exact appeal/account id, an
     account address, or a substring of the note or restriction title.

   PUT  /api/admin/appeals { id, decision: 'upheld' | 'overturned' }
     One answer per appeal. `overturned` also lifts the restriction it
     argues with (sets endsAt to now) — reversing the decision is the point
     of an overturn. Both outcomes write an audit event under the appeal's
     id and notify the account with `Ref: <appeal id>` in the message, so
     the id an operator copies here finds the filing, the decision and the
     emails on both sides. */

const DECISIONS = new Set(['upheld', 'overturned']);

export const GET = withAdmin(async (request) => {
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

export const PUT = withAdmin(async (request, session) => {
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
    include: { restriction: { select: { id: true, endsAt: true } } },
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

  await prisma.$transaction(async (tx: any) => {
    await tx.userAppeal.update({ where: { id }, data: { decision, decidedAt } });
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

  const { createAuditEvent } = await import('@/features/security/audit');
  await createAuditEvent({
    actorId: session.userId,
    action: `appeal.${decision}`,
    title: decision === 'overturned' ? 'Appeal overturned' : 'Appeal upheld',
    targetType: 'appeal',
    targetId: id,
    severity: 'info',
    metadata: { appellantId: appeal.userId, restrictionId: appeal.restrictionId, restrictionLifted },
  }).catch(() => {});

  // Security category: compulsory delivery, and the reference id lands in the
  // message body and in the email payload — search either side by this id.
  const { createNotification } = await import('@/features/notifications/notifications');
  await createNotification({
    userId: appeal.userId,
    type: 'security',
    title: restrictionLifted
      ? 'Appeal overturned — restriction lifted'
      : decision === 'overturned'
        ? 'Appeal overturned — decision reversed'
        : 'Appeal reviewed — restriction stands',
    body: restrictionLifted
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
  });
});
