import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getSessionFromRequest } from '@/lib/auth/session';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    const fields = await prisma.formField.findMany({ where: { formId: id }, orderBy: { order: 'asc' } });
    return NextResponse.json({ fields });
  } catch (error: any) {
    console.error('[FORMS] GET fields error:', error?.message);
    return NextResponse.json({ error: 'Failed to load fields' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    const body: any = await req.json();
    const { label, name, type, required, placeholder, helpText, defaultValue, options, validation, appearance, hidden, readOnly } = body;
    if (!label || !name) return NextResponse.json({ error: 'Label and name required' }, { status: 400 });

    const lastField = await prisma.formField.findFirst({ where: { formId: id }, orderBy: { order: 'desc' } });

    const field = await prisma.formField.create({
      data: {
        formId: id, label, name, type: type || 'text', required: required || false,
        placeholder: placeholder || null, helpText: helpText || null,
        defaultValue: defaultValue || null, options: options || null,
        validation: validation || null, appearance: appearance || null,
        order: (lastField?.order || 0) + 1, hidden: hidden || false, readOnly: readOnly || false,
      },
    });

    return NextResponse.json({ field }, { status: 201 });
  } catch (error: any) {
    console.error('[FORMS] POST fields error:', error?.message);
    return NextResponse.json({ error: 'Failed to add field' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    const body: any = await req.json();
    const { fieldId, fields, ...updateData } = body;

    // Bulk reorder
    if (fields && Array.isArray(fields)) {
      for (const f of fields) {
        await prisma.formField.update({ where: { id: f.id, formId: id }, data: { order: f.order } });
      }
      return NextResponse.json({ success: true });
    }

    if (!fieldId) return NextResponse.json({ error: 'fieldId or fields array required' }, { status: 400 });

    const allowed = ['label', 'name', 'type', 'required', 'placeholder', 'helpText', 'defaultValue', 'options', 'validation', 'appearance', 'hidden', 'readOnly', 'order'];
    const data: any = {};
    for (const k of allowed) {
      if (updateData[k] !== undefined) data[k] = updateData[k];
    }

    const updated = await prisma.formField.update({ where: { id: fieldId, formId: id }, data });
    return NextResponse.json({ field: updated });
  } catch (error: any) {
    console.error('[FORMS] PATCH fields error:', error?.message);
    return NextResponse.json({ error: 'Failed to update field' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSessionFromRequest(req);
    if (!session?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const form = await prisma.form.findFirst({ where: { id, userId: session.userId } });
    if (!form) return NextResponse.json({ error: 'Form not found' }, { status: 404 });

    const { searchParams } = new URL(req.url);
    const fieldId = searchParams.get('fieldId');
    if (!fieldId) return NextResponse.json({ error: 'fieldId required' }, { status: 400 });

    await prisma.formField.delete({ where: { id: fieldId, formId: id } });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[FORMS] DELETE fields error:', error?.message);
    return NextResponse.json({ error: 'Failed to delete field' }, { status: 500 });
  }
}
