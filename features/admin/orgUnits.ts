import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/infrastructure/db/prisma';
import { requirePermission } from '@/features/auth/http-guards';
import { createAuditEvent } from '@/features/security/audit';
import { clientIpOrUnknown } from '@/shared/client-ip';
import { ancestorsOf, placementRefusal } from '@/features/admin/tree';

/* Organisational units — the tree accounts hang off.
 *
 * Not a group. A unit describes the company and changes when somebody moves
 * jobs; a group describes a decision an operator made this week. They are two
 * tables because the questions asked of them differ: "who is in Support" reads a
 * group, "who reports to the Berlin office" reads this one.
 *
 * Three things this module refuses to do, each for a reason worth stating:
 *
 * 1. Delete a unit that still holds accounts or children. The cascade is written
 *    in the schema as `SetNull`, which would quietly re-home every account in it
 *    into "no unit" — an operator would find out from somebody's report six
 *    weeks later. So the handler counts first and names the number in the 409.
 * 2. Report anything but a direct account count. `accounts` on a unit is the
 *    number of rows in `users` pointing at it, not that plus every unit beneath.
 *    A tree where a parent's total silently excludes a child is worse than a
 *    column labelled what it is.
 * 3. A separate `/move` endpoint. Moving is `parentId` in the same PATCH that
 *    renames, because a form that edits a name and a parent has one Save button,
 *    and two endpoints that both write `parent_id` is two places to keep the
 *    cycle rule in agreement.
 */

const MAX_DEPTH = 8;
const MAX_LIMIT = 200;

export type OrgUnitRow = {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  parentName: string | null;
  /** Accounts pointing at this unit and no other. See refusal 2 above. */
  directAccounts: number;
  childUnits: number;
  depth: number;
  createdAt: string;
  updatedAt: string;
};

const UNIT_SELECT = {
  id: true, name: true, description: true, parentId: true, createdAt: true, updatedAt: true,
  parent: { select: { name: true } },
} as const;

const unitTree = {
  parentOf: async (id: string) => {
    const row: { parentId: string | null } | null = await prisma.orgUnit.findUnique({
      where: { id },
      select: { parentId: true },
    });
    return row?.parentId ?? null;
  },
  childrenOf: async (ids: string[]) => {
    const rows = await prisma.orgUnit.findMany({ where: { parentId: { in: ids } }, select: { id: true } });
    return rows.map((row) => row.id);
  },
};

function pageArgs(search: URLSearchParams) {
  const page = Math.max(1, Number(search.get('page')) || 1);
  const limit = Math.min(MAX_LIMIT, Number(search.get('size')) || Number(search.get('limit')) || 25);
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

function orderByFor(sort: string | null, dir: string | null) {
  const direction: 'asc' | 'desc' = dir === 'asc' ? 'asc' : 'desc';
  switch (sort) {
    case 'created':
      return [{ createdAt: direction }];
    case 'accounts':
      return [{ users: { _count: direction } }, { name: 'asc' as const }];
    default:
      return [{ name: 'asc' as const }];
  }
}

async function talliesFor(ids: string[]) {
  if (!ids.length) return new Map<string, { accounts: number; children: number }>();
  const [accountRows, childRows] = await Promise.all([
    prisma.user.groupBy({ by: ['orgUnitId'], where: { orgUnitId: { in: ids } }, _count: { _all: true } }),
    prisma.orgUnit.groupBy({ by: ['parentId'], where: { parentId: { in: ids } }, _count: { _all: true } }),
  ]);
  const out = new Map<string, { accounts: number; children: number }>();
  for (const id of ids) out.set(id, { accounts: 0, children: 0 });
  for (const row of accountRows) if (row.orgUnitId) out.get(row.orgUnitId)!.accounts = row._count._all;
  for (const row of childRows) if (row.parentId) out.get(row.parentId)!.children = row._count._all;
  return out;
}

function shape(unit: {
  id: string; name: string; description: string | null; parentId: string | null;
  createdAt: Date; updatedAt: Date; parent: { name: string } | null;
}, tally: { accounts: number; children: number }, depth: number): OrgUnitRow {
  return {
    id: unit.id,
    name: unit.name,
    description: unit.description ?? null,
    parentId: unit.parentId ?? null,
    parentName: unit.parent?.name ?? null,
    directAccounts: tally.accounts,
    childUnits: tally.children,
    depth,
    createdAt: unit.createdAt.toISOString(),
    updatedAt: unit.updatedAt.toISOString(),
  };
}

/** Levels from a unit to its root, root first = 1. Only asked for the rows on
 *  one page, so it is `page size` walks rather than one walk per unit in the
 *  table; the console sorts and filters on it, which is the whole reason it is
 *  returned. */
async function depthOf(id: string) {
  const chain = await ancestorsOf(id, MAX_DEPTH, unitTree);
  return chain.ids.length + 1;
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

export async function listOrgUnits(request: NextRequest) {
  const session = await requirePermission(request, 'units.read');
  if (session instanceof NextResponse) return session;

  const p = request.nextUrl.searchParams;
  const { page, limit, skip, take } = pageArgs(p);
  const q = (p.get('q') || p.get('search') || '').trim();

  const where: Record<string, unknown> = {};
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }
  const parentId = p.get('parent');
  if (parentId) where.parentId = parentId === 'root' ? null : parentId;
  else if (p.get('topLevel') === '1') where.parentId = null;

  const [rows, total] = await Promise.all([
    prisma.orgUnit.findMany({
      where: where as any,
      select: UNIT_SELECT,
      orderBy: orderByFor(p.get('sort'), p.get('dir')) as any,
      skip,
      take,
    }),
    prisma.orgUnit.count({ where: where as any }),
  ]);

  const tallies = await talliesFor(rows.map((row) => row.id));
  const depths = await Promise.all(rows.map((row) => depthOf(row.id)));

  return NextResponse.json({
    units: rows.map((row, index) => shape(row, tallies.get(row.id) ?? { accounts: 0, children: 0 }, depths[index])),
    total,
    page,
    limit,
    maxDepth: MAX_DEPTH,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function getOrgUnit(request: NextRequest, id: string) {
  const session = await requirePermission(request, 'units.read');
  if (session instanceof NextResponse) return session;

  const unit = await prisma.orgUnit.findUnique({ where: { id }, select: UNIT_SELECT });
  if (!unit) return NextResponse.json({ error: 'No such unit.' }, { status: 404 });

  const { page, limit, skip, take } = pageArgs(request.nextUrl.searchParams);
  const [tallies, accounts, children, ancestry] = await Promise.all([
    talliesFor([id]),
    prisma.user.findMany({
      where: { orgUnitId: id },
      select: { id: true, email: true, username: true, status: true, profile: { select: { name: true } } },
      orderBy: { email: 'asc' },
      skip,
      take,
    }),
    prisma.orgUnit.findMany({ where: { parentId: id }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ancestorsOf(id, MAX_DEPTH, unitTree),
  ]);

  const tally = tallies.get(id) ?? { accounts: 0, children: 0 };
  // The path above this unit, root first. A tree rendered as an indented list
  // does not need it; the breadcrumb beside a single unit's name does, or the
  // operator cannot tell "Sales / Berlin" from "Support / Berlin".
  const names = await prisma.orgUnit.findMany({
    where: { id: { in: ancestry.ids } },
    select: { id: true, name: true },
  });
  const byId = new Map(names.map((row) => [row.id, row.name]));

  return NextResponse.json({
    unit: shape(unit, tally, ancestry.ids.length + 1),
    path: [...ancestry.ids].reverse().map((ancestorId) => ({ id: ancestorId, name: byId.get(ancestorId) ?? null })),
    accounts: accounts.map((row) => ({
      id: row.id,
      email: row.email,
      username: row.username,
      name: row.profile?.name ?? null,
      status: row.status,
    })),
    accountsTotal: tally.accounts,
    childUnits: children,
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

async function duplicateName(name: string, parentId: string | null, exceptId?: string) {
  return prisma.orgUnit.findFirst({
    where: {
      parentId: parentId ?? null,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
}

export async function createOrgUnit(request: NextRequest) {
  const session = await requirePermission(request, 'units.manage');
  if (session instanceof NextResponse) return session;

  const parsed = writeSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'A unit needs a name, and optionally a description and a parent.' }, { status: 400 });
  }
  const { name, description, parentId = null } = parsed.data;

  if (parentId) {
    const parent = await prisma.orgUnit.findUnique({ where: { id: parentId }, select: { id: true } });
    if (!parent) return NextResponse.json({ error: 'That parent unit does not exist.' }, { status: 404 });
    const chain = await ancestorsOf(parentId, MAX_DEPTH, unitTree);
    if (chain.cycled) {
      return NextResponse.json(
        { error: 'The tree above that unit already loops back on itself. Repair it before adding to it.', },
        { status: 409 },
      );
    }
    if (chain.ids.length + 2 > MAX_DEPTH) {
      return NextResponse.json(
        { error: `That parent is already ${chain.ids.length + 1} levels down, and ${MAX_DEPTH} is the limit.` },
        { status: 409 },
      );
    }
  }

  if (await duplicateName(name, parentId)) {
    return NextResponse.json({ error: `There is already a unit called “${name}” under that parent.` }, { status: 409 });
  }

  const unit = await prisma.orgUnit.create({
    data: { name, description, parentId, createdBy: session.userId },
    select: UNIT_SELECT,
  });
  const tallies = await talliesFor([unit.id]);

  await createAuditEvent({
    actorId: session.userId,
    action: 'admin.org_unit_created',
    targetType: 'org_unit',
    targetId: unit.id,
    metadata: { name, parentId: parentId ?? null, actorEmail: session.email },
    ip: clientIpOrUnknown(request.headers),
    userAgent: request.headers.get('user-agent'),
  });

  return NextResponse.json({
    unit: shape(unit, tallies.get(unit.id) ?? { accounts: 0, children: 0 }, parentId ? 2 : 1),
  }, { status: 201 });
}

export async function updateOrgUnit(request: NextRequest, id: string) {
  const session = await requirePermission(request, 'units.manage');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.orgUnit.findUnique({
    where: { id },
    select: { id: true, name: true, description: true, parentId: true },
  });
  if (!existing) return NextResponse.json({ error: 'No such unit.' }, { status: 404 });

  const parsed = writeSchema.partial().safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Nothing to change, or a name that is not usable.' }, { status: 400 });

  const name = parsed.data.name ?? existing.name;
  const description = parsed.data.description === undefined ? existing.description : parsed.data.description;
  const parentId = parsed.data.parentId === undefined ? existing.parentId : parsed.data.parentId;

  if (parentId && parentId !== existing.parentId) {
    if (!(await prisma.orgUnit.findUnique({ where: { id: parentId }, select: { id: true } }))) {
      return NextResponse.json({ error: 'That parent unit does not exist.' }, { status: 404 });
    }
    const refusal = await placementRefusal(id, parentId, MAX_DEPTH, unitTree, { singular: 'unit', plural: 'units' });
    if (refusal) return NextResponse.json({ error: refusal.message }, { status: refusal.status });
  }

  if (name.toLowerCase() !== existing.name.toLowerCase() || parentId !== existing.parentId) {
    if (await duplicateName(name, parentId ?? null, id)) {
      return NextResponse.json({ error: `There is already a unit called “${name}” under that parent.` }, { status: 409 });
    }
  }

  const unit = await prisma.orgUnit.update({
    where: { id },
    data: { name, description: description ?? null, parentId: parentId ?? null },
    select: UNIT_SELECT,
  });
  const [tallies, depth] = await Promise.all([talliesFor([id]), depthOf(id)]);

  await createAuditEvent({
    actorId: session.userId,
    action: 'admin.org_unit_updated',
    targetType: 'org_unit',
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

  return NextResponse.json({ unit: shape(unit, tallies.get(id) ?? { accounts: 0, children: 0 }, depth) });
}

export async function deleteOrgUnit(request: NextRequest, id: string) {
  const session = await requirePermission(request, 'units.manage');
  if (session instanceof NextResponse) return session;

  const existing = await prisma.orgUnit.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!existing) return NextResponse.json({ error: 'No such unit.' }, { status: 404 });

  const [accounts, children] = await Promise.all([
    prisma.user.count({ where: { orgUnitId: id } }),
    prisma.orgUnit.count({ where: { parentId: id } }),
  ]);
  if (accounts || children) {
    // The count is the message. "Delete the children first" without a number
    // sends an operator hunting, and the number tells them whether this is a
    // two-minute job or the wrong Tuesday for it.
    return NextResponse.json({
      error: `“${existing.name}” still has ${accounts} account${accounts === 1 ? '' : 's'} and ${children} unit${children === 1 ? '' : 's'} beneath it. Move them somewhere else first.`,
      accounts,
      children,
    }, { status: 409 });
  }

  await prisma.orgUnit.delete({ where: { id } });

  await createAuditEvent({
    actorId: session.userId,
    action: 'admin.org_unit_deleted',
    severity: 'warning',
    targetType: 'org_unit',
    targetId: id,
    metadata: { name: existing.name, actorEmail: session.email },
    ip: clientIpOrUnknown(request.headers),
    userAgent: request.headers.get('user-agent'),
  });

  return NextResponse.json({ ok: true, name: existing.name });
}

/* ── Who sits in a unit ─────────────────────────────────────────────────── */

const assignSchema = z.object({
  userIds: z.array(z.string().trim().min(1)).min(1).max(MAX_LIMIT),
  /** Omit or true to place them here; false to take them out of every unit. */
  into: z.boolean().optional(),
});

export async function assignAccounts(request: NextRequest, id: string) {
  const session = await requirePermission(request, 'units.manage');
  if (session instanceof NextResponse) return session;

  const unit = await prisma.orgUnit.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!unit) return NextResponse.json({ error: 'No such unit.' }, { status: 404 });

  const parsed = assignSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Give the account ids to move.' }, { status: 400 });
  const { userIds, into = true } = parsed.data;

  const found = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, orgUnitId: true },
  });
  const known = new Set(found.map((row) => row.id));
  const unknown = userIds.filter((uid) => !known.has(uid));

  const targetId = into ? id : null;
  const moved = found.filter((row) => row.orgUnitId !== targetId);
  if (moved.length) {
    await prisma.user.updateMany({ where: { id: { in: moved.map((row) => row.id) } }, data: { orgUnitId: targetId } });
  }

  await createAuditEvent({
    actorId: session.userId,
    action: into ? 'admin.org_unit_accounts_assigned' : 'admin.org_unit_accounts_removed',
    targetType: 'org_unit',
    targetId: id,
    metadata: {
      unitName: unit.name,
      accountsMoved: moved.length,
      alreadyThere: found.length - moved.length,
      unknown,
      actorEmail: session.email,
    },
    ip: clientIpOrUnknown(request.headers),
    userAgent: request.headers.get('user-agent'),
  });

  const tally = await talliesFor([id]);
  return NextResponse.json({
    ok: true,
    moved: moved.length,
    alreadyThere: found.length - moved.length,
    unknown,
    directAccounts: tally.get(id)?.accounts ?? 0,
  });
}
