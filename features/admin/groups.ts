import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/infrastructure/db/prisma';
import { requirePermission } from '@/features/auth/http-guards';
import { createAuditEvent } from '@/features/security/audit';
import { clientIpOrUnknown } from '@/shared/client-ip';
import { ancestorsOf, placementRefusal } from '@/features/admin/tree';

/* Groups — named sets of accounts.
 *
 * A group grants nothing and changes nothing. It exists so an operator can say
 * "these ninety accounts" instead of pasting ninety ids, and so the console can
 * answer who belongs to a set. Enforcement still reads `users.status` and the
 * role registry; nothing in this file is consulted when somebody signs in.
 *
 * Two rules are worth the code they cost:
 *
 * 1. A tree, not a graph. Nesting is one parent per group, and a write that
 *    would make a group contain itself is refused. Postgres cannot express
 *    "this must stay acyclic" in a schema, so the check is here, walking up
 *    from the proposed parent — the only direction a cycle can arrive from.
 * 2. Every count this file returns is a *direct* count. A transitive count —
 *    everyone in this group plus everyone three levels down — is the number an
 *    operator wants most and the one a broken cycle guard would make infinite.
 *    The column says "Direct members", and the screen that adds a transitive
 *    total has to add the guard that makes it safe first.
 */

const MAX_DEPTH = 10;
const MAX_LIMIT = 200;

export type GroupRow = {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  parentName: string | null;
  directMembers: number;
  childGroups: number;
  createdAt: string;
  updatedAt: string;
};

function pageArgs(search: URLSearchParams) {
  const page = Math.max(1, Number(search.get('page')) || 1);
  const limit = Math.min(MAX_LIMIT, Number(search.get('size')) || Number(search.get('limit')) || 25);
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

/** The four orders the console can ask for. Anything else is the default
 *  rather than an error: a typo in a query string should show a list, not a 500. */
function orderByFor(sort: string | null, dir: string | null) {
  const descending = dir !== 'asc';
  switch (sort) {
    case 'name':
      return [{ name: 'asc' as const }];
    case 'oldest':
      return [{ createdAt: 'asc' as const }];
    case 'members':
      // A computed count cannot be ordered by directly, so the relation's own
      // row count sorts — same order, and it is the number the column shows.
      return [{ members: { _count: descending ? 'desc' : 'asc' } as const }, { createdAt: 'desc' as const }];
    case 'newest':
      return [{ createdAt: 'desc' as const }];
    default:
      return [{ name: 'asc' as const }];
  }
}

/** Every membership row of one group, counted by kind, in one query. */
async function countsFor(ids: string[]) {
  if (!ids.length) return new Map<string, { members: number; children: number }>();
  const [memberRows, childRows] = await Promise.all([
    prisma.groupMember.groupBy({ by: ['groupId'], where: { groupId: { in: ids }, userId: { not: null } }, _count: { _all: true } }),
    prisma.userGroup.groupBy({ by: ['parentId'], where: { parentId: { in: ids } }, _count: { _all: true } }),
  ]);
  const out = new Map<string, { members: number; children: number }>();
  for (const id of ids) out.set(id, { members: 0, children: 0 });
  for (const row of memberRows) out.get(row.groupId)!.members = row._count._all;
  for (const row of childRows) if (row.parentId) out.get(row.parentId)!.children = row._count._all;
  return out;
}

function shape(group: {
  id: string; name: string; description: string | null; parentId: string | null;
  createdAt: Date; updatedAt: Date; parent: { name: string } | null;
}, counts: { members: number; children: number }): GroupRow {
  return {
    id: group.id,
    name: group.name,
    description: group.description ?? null,
    parentId: group.parentId ?? null,
    parentName: group.parent?.name ?? null,
    directMembers: counts.members,
    childGroups: counts.children,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

const GROUP_SELECT = {
  id: true, name: true, description: true, parentId: true, createdAt: true, updatedAt: true,
  parent: { select: { name: true } },
} as const;

/* ── The tree, walked ───────────────────────────────────────────────────── */

/** The two queries a directory tree needs of a table, for the shared walk in
 *  `tree.ts` — one delegate per table, because the cycle rule must read the same
 *  in both and the depth caps are allowed to differ. */
const groupTree = {
  parentOf: async (id: string) => {
    const row: { parentId: string | null } | null = await prisma.userGroup.findUnique({
      where: { id },
      select: { parentId: true },
    });
    return row?.parentId ?? null;
  },
  childrenOf: async (ids: string[]) => {
    const rows = await prisma.userGroup.findMany({ where: { parentId: { in: ids } }, select: { id: true } });
    return rows.map((row) => row.id);
  },
};

export type TreeRefusal = { error: string; status: number };

/**
 * May `groupId` be placed under `parentId`? Refuses a self-parent, a cycle, and
 * a tree deeper than the cap — the three ways a nesting write stops being a
 * picture of an organisation and becomes a query that never finishes.
 */
async function nestingRefusal(groupId: string, parentId: string): Promise<TreeRefusal | null> {
  const parent = await prisma.userGroup.findUnique({ where: { id: parentId }, select: { id: true } });
  if (!parent) return { error: 'That parent group does not exist.', status: 404 };
  const refusal = await placementRefusal(groupId, parentId, MAX_DEPTH, groupTree, { singular: 'group', plural: 'groups' });
  return refusal ? { error: refusal.message, status: refusal.status } : null;
}

/** A sibling already answering to this name. Case-insensitive, and `null`
 *  parent means the top level — two groups at the root would otherwise be free
 *  to share a name and an operator could not tell which one a member list is for. */
async function duplicateName(name: string, parentId: string | null, exceptId?: string) {
  return prisma.userGroup.findFirst({
    where: {
      parentId: parentId ?? null,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true, name: true },
  });
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

export async function listGroups(request: NextRequest) {
  const session = await requirePermission(request, 'groups.read');
  if (session instanceof NextResponse) return session;

  const p = request.nextUrl.searchParams;
  const { page, limit, skip, take } = pageArgs(p);
  const q = (p.get('q') || p.get('search') || '').trim();
  const parentId = p.get('parent');

  const where: Record<string, unknown> = {};
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (parentId) where.parentId = parentId === 'root' ? null : parentId;
  else if (p.get('topLevel') === '1') where.parentId = null;

  const [rows, total] = await Promise.all([
    prisma.userGroup.findMany({
      where: where as any,
      select: GROUP_SELECT,
      orderBy: orderByFor(p.get('sort'), p.get('dir')) as any,
      skip,
      take,
    }),
    prisma.userGroup.count({ where: where as any }),
  ]);

  const counts = await countsFor(rows.map((row) => row.id));
  return NextResponse.json({
    groups: rows.map((row) => shape(row, counts.get(row.id) ?? { members: 0, children: 0 })),
    total,
    page,
    limit,
    maxDepth: MAX_DEPTH,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function getGroup(request: NextRequest, id: string) {
  const session = await requirePermission(request, 'groups.read');
  if (session instanceof NextResponse) return session;

  const group = await prisma.userGroup.findUnique({ where: { id }, select: GROUP_SELECT });
  if (!group) return NextResponse.json({ error: 'No such group.' }, { status: 404 });

  const { page, limit, skip, take } = pageArgs(request.nextUrl.searchParams);
  const [members, children, counted] = await Promise.all([
    prisma.groupMember.findMany({
      where: { groupId: id, userId: { not: null } },
      select: {
        id: true,
        note: true,
        createdAt: true,
        user: { select: { id: true, email: true, username: true, status: true, profile: { select: { name: true } } } },
        addedByUser: { select: { id: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.userGroup.findMany({
      where: { parentId: id },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    countsFor([id]),
  ]);

  const tally = counted.get(id) ?? { members: 0, children: 0 };
  return NextResponse.json({
    group: shape(group, tally),
    // Direct only, on purpose — see the header. `total` beside the page proves
    // the screen is not showing the whole set, which is the difference between
    // a list and a sample.
    members: members.map((row) => ({
      id: row.id,
      userId: row.user?.id ?? null,
      email: row.user?.email ?? null,
      username: row.user?.username ?? null,
      name: row.user?.profile?.name ?? null,
      status: row.user?.status ?? null,
      note: row.note ?? null,
      addedBy: row.addedByUser?.email ?? null,
      addedAt: row.createdAt.toISOString(),
    })),
    membersTotal: tally.members,
    nestedGroups: children,
    page,
    limit,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

/* ── Writes ─────────────────────────────────────────────────────────────── */

const writeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  parentId: z.string().trim().max(64).nullable().optional(),
});

export async function createGroup(request: NextRequest) {
  const session = await requirePermission(request, 'groups.manage');
  if (session instanceof NextResponse) return session;

  const parsed = writeSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'A group needs a name, and optionally a description and a parent.' }, { status: 400 });
  }
  const { name, description, parentId = null } = parsed.data;

  if (parentId) {
    // A group that does not exist yet cannot form a cycle, so the only things
    // worth asking are that the parent is real, is not itself inside a loop
    // nobody has noticed, and leaves room for one more level under it.
    const parent = await prisma.userGroup.findUnique({ where: { id: parentId }, select: { id: true } });
    if (!parent) return NextResponse.json({ error: 'That parent group does not exist.' }, { status: 404 });
    const chain = await ancestorsOf(parentId, MAX_DEPTH, groupTree);
    if (chain.cycled) {
      return NextResponse.json(
        { error: 'The existing tree above that parent is already a loop. Fix it before nesting anything deeper.' },
        { status: 409 },
      );
    }
    if (chain.ids.length + 2 > MAX_DEPTH) {
      return NextResponse.json(
        { error: `That parent is already ${chain.ids.length + 1} levels down, and ${MAX_DEPTH} is the limit.`, },
        { status: 409 },
      );
    }
  }

  if (await duplicateName(name, parentId)) {
    return NextResponse.json({ error: `There is already a group called “${name}” at that level.` }, { status: 409 });
  }

  const group = await prisma.userGroup.create({
    data: { name, description, parentId, createdBy: session.userId },
    select: GROUP_SELECT,
  });
  const counts = await countsFor([group.id]);

  await createAuditEvent({
    actorId: session.userId,
    action: 'admin.group_created',
    targetType: 'user_group',
    targetId: group.id,
    metadata: { name, parentId: parentId ?? null, actorEmail: session.email },
    ip: clientIpOrUnknown(request.headers),
    userAgent: request.headers.get('user-agent'),
  });

  return NextResponse.json({ group: shape(group, counts.get(group.id) ?? { members: 0, children: 0 }) }, { status: 201 });
}

export async function updateGroup(request: NextRequest, id: string) {
  const session = await requirePermission(request, 'groups.manage');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.userGroup.findUnique({
    where: { id },
    select: { id: true, name: true, description: true, parentId: true },
  });
  if (!existing) return NextResponse.json({ error: 'No such group.' }, { status: 404 });

  const parsed = writeSchema.partial().safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Nothing to change, or a name that is not usable.' }, { status: 400 });

  const name = parsed.data.name ?? existing.name;
  const description = parsed.data.description === undefined ? existing.description : parsed.data.description;
  const parentId = parsed.data.parentId === undefined ? existing.parentId : parsed.data.parentId;

  if (parentId && parentId !== existing.parentId) {
    const refusal = await nestingRefusal(id, parentId);
    if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  }
  if (name.toLowerCase() !== existing.name.toLowerCase() || parentId !== existing.parentId) {
    const clash = await duplicateName(name, parentId ?? null, id);
    if (clash) return NextResponse.json({ error: `There is already a group called “${name}” at that level.` }, { status: 409 });
  }

  const group = await prisma.userGroup.update({
    where: { id },
    data: { name, description: description ?? null, parentId: parentId ?? null },
    select: GROUP_SELECT,
  });
  const counts = await countsFor([id]);

  await createAuditEvent({
    actorId: session.userId,
    action: 'admin.group_updated',
    targetType: 'user_group',
    targetId: id,
    metadata: {
      name,
      renamed: name !== existing.name,
      moved: parentId !== existing.parentId,
      fromParent: existing.parentId ?? null,
      toParent: parentId ?? null,
      actorEmail: session.email,
    },
    ip: clientIpOrUnknown(request.headers),
    userAgent: request.headers.get('user-agent'),
  });

  return NextResponse.json({ group: shape(group, counts.get(id) ?? { members: 0, children: 0 }) });
}

export async function deleteGroup(request: NextRequest, id: string) {
  const session = await requirePermission(request, 'groups.manage');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.userGroup.findUnique({
    where: { id },
    select: { id: true, name: true, parentId: true },
  });
  if (!existing) return NextResponse.json({ error: 'No such group.' }, { status: 404 });

  // Deleting a group removes a label, not an account: the membership rows go,
  // the children keep existing and rise one level, and every account stays
  // exactly where it was. Those three numbers are what an operator needs to
  // hear before agreeing to it.
  const [members, children] = await Promise.all([
    prisma.groupMember.count({ where: { groupId: id } }),
    prisma.userGroup.count({ where: { parentId: id } }),
  ]);

  await prisma.$transaction([
    prisma.groupMember.deleteMany({ where: { groupId: id } }),
    prisma.userGroup.updateMany({ where: { parentId: id }, data: { parentId: existing.parentId ?? null } }),
    prisma.userGroup.delete({ where: { id } }),
  ]);

  await createAuditEvent({
    actorId: session.userId,
    action: 'admin.group_deleted',
    severity: 'warning',
    targetType: 'user_group',
    targetId: id,
    metadata: { name: existing.name, membershipsRemoved: members, childGroupsAdopted: children, actorEmail: session.email },
    ip: clientIpOrUnknown(request.headers),
    userAgent: request.headers.get('user-agent'),
  });

  return NextResponse.json({ ok: true, name: existing.name, membershipsRemoved: members, childGroupsAdopted: children });
}

/* ── Membership ─────────────────────────────────────────────────────────── */

const memberSchema = z.object({
  userIds: z.array(z.string().trim().min(1)).max(MAX_LIMIT).optional(),
  groupIds: z.array(z.string().trim().min(1)).max(50).optional(),
  note: z.string().trim().max(300).optional(),
});

export async function addMembers(request: NextRequest, id: string) {
  const session = await requirePermission(request, 'groups.manage');
  if (session instanceof NextResponse) return session;

  const group = await prisma.userGroup.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!group) return NextResponse.json({ error: 'No such group.' }, { status: 404 });

  const parsed = memberSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Give userIds and/or groupIds to add.' }, { status: 400 });
  }
  const userIds = [...new Set(parsed.data.userIds ?? [])];
  const groupIds = [...new Set(parsed.data.groupIds ?? [])];
  if (!userIds.length && !groupIds.length) {
    return NextResponse.json({ error: 'Nothing named to add.' }, { status: 400 });
  }
  const note = parsed.data.note;

  // Accounts that do not exist are reported, not skipped: an operator who
  // pasted forty ids wants to know that two of them were stale.
  const foundUsers = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true } });
  const knownUserIds = new Set(foundUsers.map((row) => row.id));
  const unknownUsers = userIds.filter((uid) => !knownUserIds.has(uid));

  // Nesting is refused exactly as moving a group is — a cycle entered through
  // the membership form is the same cycle.
  const nested: string[] = [];
  const refused: { id: string; reason: string }[] = [];
  for (const candidate of groupIds) {
    if (candidate === id) {
      refused.push({ id: candidate, reason: 'That is this group.' });
      continue;
    }
    if (!(await prisma.userGroup.findUnique({ where: { id: candidate }, select: { id: true } }))) {
      refused.push({ id: candidate, reason: 'No such group.' });
      continue;
    }
    const refusal = await nestingRefusal(candidate, id);
    if (refusal) {
      refused.push({ id: candidate, reason: refusal.error });
      continue;
    }
    nested.push(candidate);
  }

  const created = await prisma.$transaction(async (tx) => {
    const made: { userId?: string; memberGroupId?: string }[] = [];
    for (const userId of knownUserIds) {
      const row = await tx.groupMember.upsert({
        where: { groupId_userId: { groupId: id, userId } },
        create: { groupId: id, userId, note, addedBy: session.userId },
        update: note ? { note } : {},
        select: { userId: true },
      });
      made.push({ userId: row.userId ?? undefined });
    }
    for (const memberGroupId of nested) {
      const row = await tx.groupMember.upsert({
        where: { groupId_memberGroupId: { groupId: id, memberGroupId } },
        create: { groupId: id, memberGroupId, note, addedBy: session.userId },
        update: note ? { note } : {},
        select: { memberGroupId: true },
      });
      made.push({ memberGroupId: row.memberGroupId ?? undefined });
    }
    return made;
  });

  await createAuditEvent({
    actorId: session.userId,
    action: 'admin.group_members_added',
    targetType: 'user_group',
    targetId: id,
    metadata: {
      groupName: group.name,
      accounts: created.filter((row) => row.userId).length,
      nestedGroups: created.filter((row) => row.memberGroupId).length,
      unknownUsers,
      refused,
      actorEmail: session.email,
    },
    ip: clientIpOrUnknown(request.headers),
    userAgent: request.headers.get('user-agent'),
  });

  const counts = await countsFor([id]);
  return NextResponse.json({
    ok: true,
    added: created.length,
    directMembers: counts.get(id)?.members ?? 0,
    // Not a success report with holes in it: the caller gets the same shape for
    // what did not happen as for what did, and says so out loud.
    unknownUsers,
    refused,
  });
}

export async function removeMember(request: NextRequest, id: string, memberId: string) {
  const session = await requirePermission(request, 'groups.manage');
  if (session instanceof NextResponse) return session;

  const row = await prisma.groupMember.findFirst({
    // `id` in the path is the group; `memberId` is the membership row. Scoping
    // the find to the group means a row from another group cannot be removed by
    // guessing its id.
    where: { id: memberId, groupId: id },
    select: { id: true, userId: true, memberGroupId: true, user: { select: { email: true } } },
  });
  if (!row) return NextResponse.json({ error: 'No such member of that group.' }, { status: 404 });

  await prisma.groupMember.delete({ where: { id: row.id } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'admin.group_member_removed',
    targetType: 'user_group',
    targetId: id,
    metadata: {
      removedAccount: row.user?.email ?? null,
      removedGroup: row.memberGroupId ?? null,
      actorEmail: session.email,
    },
    ip: clientIpOrUnknown(request.headers),
    userAgent: request.headers.get('user-agent'),
  });

  return NextResponse.json({ ok: true, memberId: row.id });
}
