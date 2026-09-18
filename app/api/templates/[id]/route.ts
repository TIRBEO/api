import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/infrastructure/db/prisma';
import { getSessionFromRequest } from '@/features/auth/session';
import { getTemplateById } from '@/features/forms/formTemplates';

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function generateAccessKey(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return `tb_live_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

// POST /api/templates/{id} — instantiate a template as a real draft Form
// (matches the standalone /api/forms POST contract: slug + access key + fields).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const template = getTemplateById(id);
    if (!template) return NextResponse.json({ error: 'Template not found' }, { status: 404 });

    const slug = generateSlug(`${template.name} ${Date.now().toString(36)}`);
    const form = await prisma.form.create({
      data: {
        name: template.name,
        description: template.description,
        slug,
        accessKey: generateAccessKey(),
        userId: session.userId,
        status: 'draft',
        fields: {
          create: template.fields.map((f, i) => ({
            label: f.label,
            name: `field_${i + 1}`,
            type: f.type,
            required: !!f.required,
            placeholder: f.placeholder || null,
            options: (f.options || null) as Prisma.InputJsonValue | null,
            order: i,
          })),
        },
      },
      include: { fields: { orderBy: { order: 'asc' } } },
    });

    return NextResponse.json({ id: form.id, form }, { status: 201 });
  } catch (error: any) {
    console.error('[TEMPLATES] POST error:', error?.message);
    return NextResponse.json({ error: 'Failed to create form from template' }, { status: 500 });
  }
}
