import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../lib/db/prisma';
import { requireAdmin } from '@/lib/session';

const groupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  slug: z.string().min(1).max(100).optional(),
});

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const groups = await prisma.group.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { members: true } },
    },
  });

  return NextResponse.json({ groups });
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const parsed = groupSchema.safeParse(body);
  if (!parsed.success) {
    return new NextResponse('Invalid payload: ' + JSON.stringify(parsed.error.flatten()), { status: 400 });
  }

  const slug = parsed.data.slug || parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const existing = await prisma.group.findUnique({ where: { slug } });
  if (existing) return new NextResponse('Group with this slug already exists', { status: 409 });

  const nameExists = await prisma.group.findUnique({ where: { name: parsed.data.name } });
  if (nameExists) return new NextResponse('Group with this name already exists', { status: 409 });

  const group = await prisma.group.create({
    data: {
      name: parsed.data.name,
      description: parsed.data.description,
      slug,
    },
  });

  return NextResponse.json(group, { status: 201 });
}
