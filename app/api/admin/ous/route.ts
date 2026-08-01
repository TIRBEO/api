import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../lib/db/prisma';
import { requireAdmin } from '@/lib/session';

const ouSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  slug: z.string().min(1).max(100).optional(),
  parentId: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const ous = await prisma.organizationalUnit.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ ous });
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session instanceof NextResponse) return session;

  const body = await request.json();
  const parsed = ouSchema.safeParse(body);
  if (!parsed.success) {
    return new NextResponse('Invalid payload: ' + JSON.stringify(parsed.error.flatten()), { status: 400 });
  }

  const slug = parsed.data.slug || parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const existing = await prisma.organizationalUnit.findUnique({ where: { slug } });
  if (existing) return new NextResponse('Organizational unit with this slug already exists', { status: 409 });

  const nameExists = await prisma.organizationalUnit.findUnique({ where: { name: parsed.data.name } });
  if (nameExists) return new NextResponse('Organizational unit with this name already exists', { status: 409 });

  if (parsed.data.parentId) {
    const parent = await prisma.organizationalUnit.findUnique({ where: { id: parsed.data.parentId } });
    if (!parent) return new NextResponse('Parent organizational unit not found', { status: 404 });
  }

  const ou = await prisma.organizationalUnit.create({
    data: {
      name: parsed.data.name,
      description: parsed.data.description,
      slug,
      parentId: parsed.data.parentId,
    },
  });

  return NextResponse.json(ou, { status: 201 });
}
